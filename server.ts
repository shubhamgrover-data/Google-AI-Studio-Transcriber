import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import express from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import ffmpegStatic from 'ffmpeg-static';
import Groq from 'groq-sdk';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  APPS_SCRIPT_BRIDGE_CODE,
  APPS_SCRIPT_MANIFEST_JSON,
  computeSourceKey,
  downloadDriveAudioToTemp,
  formatDriveVideoFolderName,
  formatRecommendationTimestamp,
  getBridgeConfigurationError,
  getLatestRecommendationFromDrive,
  isDriveBridgeConfigured,
  isDriveRequestAuthorized,
  isPasscodeRequired,
  isValidDriveFileId,
  isValidSourceKey,
  listDriveLibrary,
  lookupDriveCache,
  mintOwnerSessionToken,
  pingDriveBridge,
  saveAudioFileToDrive,
  saveRecommendationToDrive,
  saveTranscriptBundleToDrive,
  trashDriveEntry,
  verifyOwnerPasscode,
  type DriveJobPayload,
  type DriveLookupResult,
  type DriveTranscriptFileIds,
  type RecommendationEntryPayload,
  type RecommendationSnapshotPayload,
  type RecommendationSourceFilePayload,
} from './server/driveBridge.ts';

dotenv.config();

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 25 MB upload limit
const MAX_EXTRACTED_AUDIO_BYTES = 80 * 1024 * 1024; // 80 MB (~5 hours of 32kbps mono speech MP3)
const INLINE_MEDIA_LIMIT_BYTES = 10 * 1024 * 1024; // 10 MB inline; larger uses Gemini Files API
const GROQ_WHISPER_MODEL = 'whisper-large-v3';
const OPENAI_COMPAT_ANALYSIS_BASE_URL = (
  process.env.ANALYSIS_OPENAI_BASE_URL || 'https://apps.mrcoder.buzz/gpt/v1'
).replace(/\/+$/, '');
const OPENAI_COMPAT_ANALYSIS_MODEL =
  process.env.ANALYSIS_OPENAI_MODEL || 'gpt-5.4-2026-03-05';
const GROQ_MAX_SINGLE_FILE_BYTES = 18 * 1024 * 1024; // Keep well under Groq 25 MB file limit
const GROQ_CHUNK_DURATION_SECONDS = 900; // 15-minute chunks (~3.6 MB each at 32 kbps mono MP3)
const DEEPGRAM_MODEL = 'nova-3';
const DEEPGRAM_LISTEN_ENDPOINT = 'https://api.deepgram.com/v1/listen';
const DEEPGRAM_MAX_SINGLE_FILE_BYTES = 30 * 1024 * 1024; // Stream directly up to 30 MB; chunk larger files
const DEEPGRAM_CHUNK_DURATION_SECONDS = 1200; // 20-minute chunks for very large files
const GEMINI_MODEL = 'gemini-4-hydrogen';
const FFMPEG_BIN =
  typeof ffmpegStatic === 'string' && existsSync(ffmpegStatic) ? ffmpegStatic : 'ffmpeg';
const YTDLP_BIN_PATH = path.join(os.tmpdir(), 'cuescript-yt-dlp-linux-elf');
const YTDLP_DOWNLOAD_URL =
  process.arch === 'arm64'
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

interface EphemeralMediaEntry {
  filePath: string;
  mimeType: string;
  createdAt: number;
}

const ephemeralMediaStore = new Map<string, EphemeralMediaEntry>();
let ytdlpReadyPromise: Promise<string> | null = null;

function registerEphemeralMedia(filePath: string, mimeType: string): string {
  const now = Date.now();
  // Clean entries older than 45 minutes or exceeding 10 active clips
  for (const [key, entry] of ephemeralMediaStore.entries()) {
    if (now - entry.createdAt > 45 * 60 * 1000) {
      ephemeralMediaStore.delete(key);
      fs.unlink(entry.filePath).catch(() => {});
    }
  }
  while (ephemeralMediaStore.size >= 10) {
    const oldestKey = ephemeralMediaStore.keys().next().value;
    if (!oldestKey) break;
    const oldest = ephemeralMediaStore.get(oldestKey);
    ephemeralMediaStore.delete(oldestKey);
    if (oldest) fs.unlink(oldest.filePath).catch(() => {});
  }

  const mediaId = crypto.randomBytes(8).toString('hex');
  ephemeralMediaStore.set(mediaId, { filePath, mimeType, createdAt: now });
  return mediaId;
}

async function ensureYtDlpBinary(): Promise<string> {
  if (existsSync(YTDLP_BIN_PATH)) {
    try {
      const stat = statSync(YTDLP_BIN_PATH);
      if (stat.size > 10 * 1024 * 1024) {
        return YTDLP_BIN_PATH;
      }
    } catch {
      // Fall through to re-download
    }
  }
  if (!ytdlpReadyPromise) {
    ytdlpReadyPromise = (async () => {
      // Download official self-contained Linux ELF yt-dlp binary (zero python3 dependency)
      const res = await fetch(YTDLP_DOWNLOAD_URL, {
        redirect: 'follow',
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch standalone yt-dlp_linux binary (HTTP ${res.status})`);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      // Verify ELF header (\x7fELF) so we never cache a truncated or HTML error page
      if (bytes.length < 10 * 1024 * 1024 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
        throw new Error('Downloaded yt-dlp binary failed integrity check.');
      }
      const tmpPath = `${YTDLP_BIN_PATH}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(tmpPath, bytes);
      await fs.chmod(tmpPath, 0o755);
      await fs.rename(tmpPath, YTDLP_BIN_PATH);
      return YTDLP_BIN_PATH;
    })().catch((err) => {
      ytdlpReadyPromise = null;
      throw err;
    });
  }
  return ytdlpReadyPromise;
}

const DIRECT_AUDIO_EXT_TO_MIME: Record<string, string> = {
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

async function extractSocialAudioWithYtDlp(targetUrl: string): Promise<{
  audioPath: string;
  mimeType: string;
  mediaId: string;
  title?: string;
  author?: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
}> {
  const ytdlpBin = await ensureYtDlpBinary();
  const workDir = path.join(os.tmpdir(), `cuescript_job_${crypto.randomBytes(6).toString('hex')}`);
  await fs.mkdir(workDir, { recursive: true });

  const outputTemplate = path.join(workDir, 'source.%(ext)s');
  let rawMediaFile: string | undefined;

  try {
    const ytdlpArgs = [
      '--no-playlist',
      '--no-warnings',
      '--write-info-json',
      '--max-filesize',
      '150M',
      '-f',
      'bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best',
      ...(FFMPEG_BIN !== 'ffmpeg' ? ['--ffmpeg-location', FFMPEG_BIN] : []),
      '-o',
      outputTemplate,
      '--',
      targetUrl,
    ];
    await execFileAsync(ytdlpBin, ytdlpArgs, {
      timeout: 90000,
      maxBuffer: 4 * 1024 * 1024,
    });

    const files = await fs.readdir(workDir);
    const infoFile = files.find((f) => f.endsWith('.info.json'));
    const mediaFile = files.find((f) => !f.endsWith('.info.json') && !f.endsWith('.part'));

    if (!mediaFile) {
      throw new Error('yt-dlp did not produce an audio or video file for this link.');
    }

    rawMediaFile = path.join(workDir, mediaFile);

    let title: string | undefined;
    let author: string | undefined;
    let durationSeconds: number | undefined;
    let thumbnailUrl: string | undefined;

    if (infoFile) {
      try {
        const infoRaw = await fs.readFile(path.join(workDir, infoFile), 'utf-8');
        const info = JSON.parse(infoRaw) as {
          title?: string;
          description?: string;
          uploader?: string;
          channel?: string;
          duration?: number;
          thumbnail?: string;
        };
        title = info.title?.trim() || undefined;
        author = (info.uploader || info.channel || '').trim() || undefined;
        if (typeof info.duration === 'number' && Number.isFinite(info.duration)) {
          durationSeconds = Math.round(info.duration);
        }
        thumbnailUrl = info.thumbnail;
      } catch {
        // Metadata JSON optional
      }
    }

    const rawExt = path.extname(rawMediaFile).toLowerCase();
    const rawStat = await fs.stat(rawMediaFile);
    let finalAudioPath: string;
    let finalMimeType: string;

    // Fast path: yt-dlp already downloaded native audio (.m4a, .mp3, .wav, .ogg, .flac) -> zero re-encoding!
    if (DIRECT_AUDIO_EXT_TO_MIME[rawExt] && rawStat.size <= MAX_EXTRACTED_AUDIO_BYTES) {
      finalAudioPath = path.join(
        os.tmpdir(),
        `cuescript_audio_${crypto.randomBytes(6).toString('hex')}${rawExt}`
      );
      finalMimeType = DIRECT_AUDIO_EXT_TO_MIME[rawExt];
      await fs.copyFile(rawMediaFile, finalAudioPath);
    } else {
      // Video container or other audio codec: try instant stream-copy to .m4a first, then fast MP3 fallback
      const copyM4aPath = path.join(
        os.tmpdir(),
        `cuescript_audio_${crypto.randomBytes(6).toString('hex')}.m4a`
      );
      let streamCopied = false;
      try {
        await execFileAsync(
          FFMPEG_BIN,
          ['-nostats', '-loglevel', 'error', '-y', '-i', rawMediaFile, '-vn', '-c:a', 'copy', copyM4aPath],
          { timeout: 45000, maxBuffer: 4 * 1024 * 1024 }
        );
        const copyStat = await fs.stat(copyM4aPath);
        if (copyStat.size > 0 && copyStat.size <= MAX_EXTRACTED_AUDIO_BYTES) {
          streamCopied = true;
        } else {
          await fs.unlink(copyM4aPath).catch(() => {});
        }
      } catch {
        await fs.unlink(copyM4aPath).catch(() => {});
      }

      if (streamCopied) {
        finalAudioPath = copyM4aPath;
        finalMimeType = 'audio/mp4';
      } else {
        const mp3Path = path.join(
          os.tmpdir(),
          `cuescript_audio_${crypto.randomBytes(6).toString('hex')}.mp3`
        );
        try {
          await execFileAsync(
            FFMPEG_BIN,
            [
              '-nostats',
              '-loglevel',
              'error',
              '-y',
              '-i',
              rawMediaFile,
              '-vn',
              '-ac',
              '1',
              '-ar',
              '16000',
              '-b:a',
              '32k',
              '-compression_level',
              '0',
              mp3Path,
            ],
            {
              timeout: 300000,
              maxBuffer: 4 * 1024 * 1024,
            }
          );
        } catch (ffmpegErr) {
          await fs.unlink(mp3Path).catch(() => {});
          const detail = ffmpegErr instanceof Error ? ffmpegErr.message : String(ffmpegErr);
          throw new Error(`AUDIO_PROCESSING_ERROR: ${detail}`);
        }
        finalAudioPath = mp3Path;
        finalMimeType = 'audio/mpeg';
      }
    }

    const finalStat = await fs.stat(finalAudioPath);
    if (finalStat.size > MAX_EXTRACTED_AUDIO_BYTES) {
      await fs.unlink(finalAudioPath).catch(() => {});
      throw new Error('FILE_TOO_LARGE');
    }

    if (!durationSeconds) {
      durationSeconds = await probeAudioDuration(finalAudioPath);
    }

    const mediaId = registerEphemeralMedia(finalAudioPath, finalMimeType);
    return {
      audioPath: finalAudioPath,
      mimeType: finalMimeType,
      mediaId,
      title,
      author,
      durationSeconds,
      thumbnailUrl,
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

type Platform = 'youtube' | 'facebook' | 'instagram' | 'direct_url' | 'file_upload';

interface RawSegment {
  startSeconds?: number;
  endSeconds?: number;
  speakerId?: string;
  text?: string;
}

interface RawChapter {
  title?: string;
  startSeconds?: number;
  endSeconds?: number;
  summary?: string;
}

interface RawTranscriptPayload {
  title?: string;
  language?: string;
  durationSeconds?: number;
  summary?: string;
  chapters?: RawChapter[];
  segments?: RawSegment[];
}

function getGroqClient(): Groq | null {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GROQ_API_KEY') {
    return null;
  }
  return new Groq({ apiKey });
}

function getDeepgramApiKey(): string | null {
  const apiKey = process.env.DEEPGRAM_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_DEEPGRAM_API_KEY') {
    return null;
  }
  return apiKey;
}

function hasGeminiApiKey(): boolean {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  return Boolean(apiKey && apiKey !== 'MY_GEMINI_API_KEY');
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY_MISSING');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const TRANSCRIPT_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: {
      type: Type.STRING,
      description: 'Concise descriptive title of the video or audio recording.',
    },
    language: {
      type: Type.STRING,
      description: 'Primary spoken language (e.g., English, Spanish, Hindi).',
    },
    durationSeconds: {
      type: Type.NUMBER,
      description: 'Total duration of the spoken content in seconds.',
    },
    summary: {
      type: Type.STRING,
      description: 'Two to three sentence executive summary of what is discussed in the video.',
    },
    chapters: {
      type: Type.ARRAY,
      description: 'Logical topic chapters dividing the video timeline in chronological order.',
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: 'Short title for the chapter.' },
          startSeconds: { type: Type.NUMBER, description: 'Chapter start time in seconds.' },
          endSeconds: { type: Type.NUMBER, description: 'Chapter end time in seconds.' },
          summary: { type: Type.STRING, description: 'One-sentence summary of this chapter.' },
        },
        required: ['title', 'startSeconds', 'endSeconds', 'summary'],
      },
    },
    segments: {
      type: Type.ARRAY,
      description: 'Chronological timestamped transcript segments with speaker labels.',
      items: {
        type: Type.OBJECT,
        properties: {
          startSeconds: { type: Type.NUMBER, description: 'Exact start timestamp in seconds.' },
          endSeconds: { type: Type.NUMBER, description: 'Exact end timestamp in seconds.' },
          speakerId: {
            type: Type.STRING,
            description: 'Consistent speaker identifier such as "Speaker 1", "Speaker 2", or the speaker name if clearly introduced.',
          },
          text: { type: Type.STRING, description: 'Accurate, well-punctuated verbatim transcript text for this segment.' },
        },
        required: ['startSeconds', 'endSeconds', 'speakerId', 'text'],
      },
    },
  },
  required: ['title', 'language', 'durationSeconds', 'summary', 'chapters', 'segments'],
};

const TRANSCRIPTION_INSTRUCTIONS = [
  'You are a precision broadcast transcription and diarization engine.',
  'Transcribe the spoken audio verbatim from start to finish in the original spoken language.',
  'Requirements:',
  '1. Break the transcript into natural spoken segments (typically 4 to 15 seconds each or at speaker turns).',
  '2. Provide accurate chronological startSeconds and endSeconds in numeric seconds (never negative, always endSeconds > startSeconds).',
  '3. Label speakers consistently (use "Speaker 1", "Speaker 2", etc., or their actual name if explicitly stated in the audio).',
  '4. Group the video into 2 to 6 clear chronological chapters with concise titles and one-sentence summaries.',
  '5. Write a clear, factual 2-3 sentence summary of the entire recording.',
  '6. Do not fabricate dialogue that is not spoken. If a section is purely music or silence with no speech, briefly note "[Instrumental / Music]" only if significant.',
].join('\n');

function isPrivateOrBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '::' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('::ffff:')
  ) {
    return true;
  }
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

function extractYouTubeVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let id: string | null = null;

  if (host === 'youtu.be') {
    id = url.pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v');
    } else {
      const parts = url.pathname.split('/').filter(Boolean);
      if (['shorts', 'embed', 'live', 'v'].includes(parts[0] ?? '') && parts[1]) {
        id = parts[1];
      }
    }
  }

  if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) {
    return id;
  }
  return null;
}

function classifyUrl(rawUrl: string): {
  parsedUrl: URL;
  platform: Platform;
  youtubeId?: string;
} | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return null;
  }
  if (isPrivateOrBlockedHost(parsedUrl.hostname)) {
    return null;
  }

  const host = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
  const youtubeId = extractYouTubeVideoId(parsedUrl);
  if (youtubeId) {
    return { parsedUrl, platform: 'youtube', youtubeId };
  }
  if (host === 'facebook.com' || host === 'm.facebook.com' || host === 'fb.watch' || host === 'web.facebook.com') {
    return { parsedUrl, platform: 'facebook' };
  }
  if (host === 'instagram.com' || host === 'm.instagram.com' || host === 'instagr.am') {
    return { parsedUrl, platform: 'instagram' };
  }
  if (/\.(mp4|mov|webm|mp3|wav|m4a|ogg|aac)(\?.*)?$/i.test(parsedUrl.pathname + parsedUrl.search)) {
    return { parsedUrl, platform: 'direct_url' };
  }

  return null;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractMetaTag(html: string, propertyName: string): string | undefined {
  const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern1 = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
    'i'
  );
  const pattern2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`,
    'i'
  );
  const match = html.match(pattern1) || html.match(pattern2);
  return match?.[1] ? decodeHtmlEntities(match[1]) : undefined;
}

async function fetchYouTubeMetadata(canonicalUrl: string): Promise<{
  title?: string;
  author?: string;
  thumbnailUrl?: string;
}> {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`;
    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return {};
    const data = (await res.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    return {
      title: data.title,
      author: data.author_name,
      thumbnailUrl: data.thumbnail_url,
    };
  } catch {
    return {};
  }
}

async function tryExtractPublicSocialMedia(
  url: URL,
  platform: 'facebook' | 'instagram'
): Promise<{
  mediaUrl?: string;
  title?: string;
  thumbnailUrl?: string;
  reason: string;
}> {
  try {
    const response = await fetch(url.toString(), {
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const finalUrl = response.url || url.toString();
    if (!response.ok) {
      return {
        reason: `${platform === 'facebook' ? 'Facebook' : 'Instagram'} returned HTTP ${response.status} to server-side extraction.`,
      };
    }

    const html = await response.text();
    const ogTitle = extractMetaTag(html, 'og:title');
    const ogImage = extractMetaTag(html, 'og:image');

    const candidateUrls: string[] = [];
    const ogVideoSecure = extractMetaTag(html, 'og:video:secure_url');
    const ogVideo = extractMetaTag(html, 'og:video');
    if (ogVideoSecure) candidateUrls.push(ogVideoSecure);
    if (ogVideo) candidateUrls.push(ogVideo);

    // Inspect embedded JSON fields commonly exposed on public Meta pages
    const jsonFieldPatterns = [
      /"browser_native_hd_url"\s*:\s*"([^"]+)"/,
      /"browser_native_sd_url"\s*:\s*"([^"]+)"/,
      /"playable_url_quality_hd"\s*:\s*"([^"]+)"/,
      /"playable_url"\s*:\s*"([^"]+)"/,
      /"video_url"\s*:\s*"([^"]+)"/,
    ];
    for (const pattern of jsonFieldPatterns) {
      const m = html.match(pattern);
      if (m?.[1]) {
        candidateUrls.push(decodeHtmlEntities(m[1]));
      }
    }

    const playableUrl = candidateUrls.find((candidate) => {
      try {
        const parsed = new URL(candidate);
        return (
          (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
          !isPrivateOrBlockedHost(parsed.hostname) &&
          !parsed.pathname.endsWith('.html')
        );
      } catch {
        return false;
      }
    });

    if (playableUrl) {
      return {
        mediaUrl: playableUrl,
        title: ogTitle,
        thumbnailUrl: ogImage,
        reason: 'Extracted public stream URL.',
      };
    }

    const hitLoginRedirect =
      finalUrl.includes('/accounts/login') ||
      finalUrl.includes('/login') ||
      /log in|sign in to continue|login_form/i.test(html.slice(0, 15000));

    return {
      title: ogTitle,
      thumbnailUrl: ogImage,
      reason: hitLoginRedirect
        ? `${platform === 'facebook' ? 'Facebook' : 'Instagram'} redirected the server request to a login wall (datacenter IP / missing session cookies).`
        : `${platform === 'facebook' ? 'Facebook' : 'Instagram'} served a dynamic shell without an exposed public media stream URL.`,
    };
  } catch (err) {
    return {
      reason:
        err instanceof Error
          ? `Server request to ${platform} failed (${err.message}).`
          : `Server request to ${platform} timed out or was blocked.`,
    };
  }
}

async function fetchWithValidatedRedirects(
  initialUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxRedirects = 5
): Promise<globalThis.Response> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const parsed = new URL(currentUrl);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || isPrivateOrBlockedHost(parsed.hostname)) {
      throw new Error('BLOCKED_HOST');
    }
    const response = await fetch(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`UPSTREAM_HTTP_${response.status}`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return response;
  }
  throw new Error('TOO_MANY_REDIRECTS');
}

async function downloadMediaBuffer(mediaUrl: string): Promise<{
  buffer: Buffer;
  mimeType: string;
}> {
  const response = await fetchWithValidatedRedirects(
    mediaUrl,
    {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    },
    25000
  );

  if (!response.ok) {
    throw new Error(`UPSTREAM_HTTP_${response.status}`);
  }

  const finalParsed = new URL(response.url || mediaUrl);
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader && Number(contentLengthHeader) > MAX_MEDIA_BYTES) {
    throw new Error('FILE_TOO_LARGE');
  }

  const rawContentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const inferredMime = inferMimeType(rawContentType, finalParsed.pathname);
  if (!inferredMime) {
    throw new Error('UNSUPPORTED_MEDIA');
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const ab = await response.arrayBuffer();
    if (ab.byteLength > MAX_MEDIA_BYTES) throw new Error('FILE_TOO_LARGE');
    return { buffer: Buffer.from(ab), mimeType: inferredMime };
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > MAX_MEDIA_BYTES) {
        await reader.cancel();
        throw new Error('FILE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  }

  return { buffer: Buffer.concat(chunks), mimeType: inferredMime };
}

function inferMimeType(contentType: string, filenameOrPath: string): string | null {
  if (contentType.startsWith('audio/') || contentType.startsWith('video/')) {
    return contentType;
  }
  const lower = filenameOrPath.toLowerCase();
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.aac')) return 'audio/aac';
  return null;
}

function normalizeTranscriptResult(
  raw: RawTranscriptPayload,
  meta: {
    sourceType: Platform;
    sourceUrl?: string;
    fileName?: string;
    mimeType?: string;
    embedVideoId?: string;
    mediaKind: 'youtube' | 'video' | 'audio' | 'none';
    remoteMediaUrl?: string;
    thumbnailUrl?: string;
    fallbackTitle: string;
    author?: string;
    extractionMethod: string;
    sourceKey?: string;
    driveFolderId?: string;
    driveFolderName?: string;
    driveAudioFileId?: string;
    driveAudioMimeType?: string;
    driveTranscriptFileIds?: DriveTranscriptFileIds;
    syncedToDrive?: boolean;
    loadedFromCache?: boolean;
    syncedAt?: string;
  }
) {
  const rawSegments = Array.isArray(raw.segments) ? raw.segments : [];
  const segments = rawSegments
    .filter((s) => typeof s.text === 'string' && s.text.trim().length > 0)
    .map((s, idx) => {
      const start = Math.max(0, Number.isFinite(Number(s.startSeconds)) ? Number(s.startSeconds) : idx * 5);
      const rawEnd = Number.isFinite(Number(s.endSeconds)) ? Number(s.endSeconds) : start + 4;
      const end = rawEnd > start ? rawEnd : start + 2;
      const speakerId = (s.speakerId || 'Speaker 1').trim() || 'Speaker 1';
      return {
        id: `seg_${idx + 1}`,
        startSeconds: Number(start.toFixed(2)),
        endSeconds: Number(end.toFixed(2)),
        speakerId,
        text: (s.text || '').trim(),
      };
    })
    .sort((a, b) => a.startSeconds - b.startSeconds);

  const speakers: Record<string, string> = {};
  for (const seg of segments) {
    if (!speakers[seg.speakerId]) {
      speakers[seg.speakerId] = seg.speakerId;
    }
  }
  if (Object.keys(speakers).length === 0) {
    speakers['Speaker 1'] = 'Speaker 1';
  }

  const lastSegEnd = segments.length > 0 ? segments[segments.length - 1].endSeconds : 0;
  const durationSeconds = Math.max(
    lastSegEnd,
    Number.isFinite(Number(raw.durationSeconds)) ? Number(raw.durationSeconds) : 0
  );

  const rawChapters = Array.isArray(raw.chapters) ? raw.chapters : [];
  const chapters = rawChapters
    .filter((ch) => typeof ch.title === 'string' && ch.title.trim().length > 0)
    .map((ch, idx) => {
      const start = Math.max(0, Number.isFinite(Number(ch.startSeconds)) ? Number(ch.startSeconds) : 0);
      const rawEnd = Number.isFinite(Number(ch.endSeconds)) ? Number(ch.endSeconds) : durationSeconds;
      return {
        id: `ch_${idx + 1}`,
        title: (ch.title || `Chapter ${idx + 1}`).trim(),
        startSeconds: Number(start.toFixed(2)),
        endSeconds: Number(Math.max(start + 1, rawEnd).toFixed(2)),
        summary: (ch.summary || '').trim(),
      };
    })
    .sort((a, b) => a.startSeconds - b.startSeconds);

  return {
    id: `job_${crypto.randomBytes(6).toString('hex')}`,
    createdAt: new Date().toISOString(),
    sourceType: meta.sourceType,
    sourceUrl: meta.sourceUrl,
    fileName: meta.fileName,
    mimeType: meta.mimeType,
    embedVideoId: meta.embedVideoId,
    mediaKind: meta.mediaKind,
    remoteMediaUrl: meta.remoteMediaUrl,
    thumbnailUrl: meta.thumbnailUrl,
    title: meta.fallbackTitle || (raw.title || 'Untitled Transcript').trim(),
    author: meta.author,
    language: (raw.language || 'Unknown').trim(),
    durationSeconds: Math.round(durationSeconds),
    summary: (raw.summary || 'Transcript generated from media audio track.').trim(),
    speakers,
    chapters,
    segments,
    extractionMethod: meta.extractionMethod,
    sourceKey: meta.sourceKey,
    driveFolderId: meta.driveFolderId,
    driveFolderName: meta.driveFolderName,
    driveAudioFileId: meta.driveAudioFileId,
    driveAudioMimeType: meta.driveAudioMimeType,
    driveTranscriptFileIds: meta.driveTranscriptFileIds,
    syncedToDrive: meta.syncedToDrive,
    loadedFromCache: meta.loadedFromCache,
    syncedAt: meta.syncedAt,
  };
}

const CHUNK_DURATION_SECONDS = 600; // 10-minute chunks keep long videos well within RPM limits
const GEMINI_FALLBACK_MODEL = 'gemini-3.1-flash-lite';
let hydrogenCooldownUntil = 0;

type ProgressUpdater = (stepIndex: number, stageLabel: string, progressPct: number) => void;

function isTransientGeminiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /503|429|RESOURCE_EXHAUSTED|UNAVAILABLE|high demand|overloaded|ETIMEDOUT|ECONNRESET/i.test(msg);
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|RESOURCE_EXHAUSTED/i.test(msg);
}

async function generateStructuredTranscriptWithRetry(
  ai: GoogleGenAI,
  parts: Array<
    | { text: string }
    | { inlineData: { mimeType: string; data: string } }
    | { fileData: { fileUri: string; mimeType: string } }
  >
): Promise<RawTranscriptPayload> {
  const preferFallback = Date.now() < hydrogenCooldownUntil;
  const attempts: Array<{ model: string; useLowThinking: boolean; delayMs: number }> = preferFallback
    ? [
        { model: GEMINI_FALLBACK_MODEL, useLowThinking: false, delayMs: 0 },
        { model: GEMINI_FALLBACK_MODEL, useLowThinking: false, delayMs: 3000 },
        { model: GEMINI_MODEL, useLowThinking: true, delayMs: 5000 },
        { model: GEMINI_FALLBACK_MODEL, useLowThinking: false, delayMs: 12000 },
      ]
    : [
        { model: GEMINI_MODEL, useLowThinking: true, delayMs: 0 },
        { model: GEMINI_FALLBACK_MODEL, useLowThinking: false, delayMs: 800 },
        { model: GEMINI_FALLBACK_MODEL, useLowThinking: false, delayMs: 4000 },
        { model: GEMINI_FALLBACK_MODEL, useLowThinking: false, delayMs: 12000 },
      ];

  let lastError: unknown;
  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    if (attempt.delayMs > 0) {
      const waitMs = lastError && isRateLimitError(lastError) ? Math.max(attempt.delayMs, 9000) : attempt.delayMs;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    try {
      const response = await ai.models.generateContent({
        model: attempt.model,
        contents: [{ role: 'user', parts }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: TRANSCRIPT_RESPONSE_SCHEMA,
          ...(attempt.useLowThinking
            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
            : {}),
        },
      });
      return parseGeminiJson(response.text);
    } catch (err) {
      lastError = err;
      if (attempt.model === GEMINI_MODEL && isTransientGeminiError(err)) {
        hydrogenCooldownUntil = Date.now() + 90_000;
      }
      if (!isTransientGeminiError(err)) {
        throw err;
      }
    }
  }
  throw lastError;
}

async function transcribeSingleInlineChunk(
  ai: GoogleGenAI,
  buffer: Buffer,
  mimeType: string,
  contextHint: string,
  chunkMeta?: { index: number; total: number; offsetSeconds: number }
): Promise<RawTranscriptPayload> {
  const chunkNote = chunkMeta
    ? `This is part ${chunkMeta.index + 1} of ${chunkMeta.total} of a longer recording. Return timestamps relative to the start of THIS audio clip (starting at 0 seconds). Group speech into crisp 10 to 25 second segments and 1 to 2 chapters for this part.`
    : '';

  const promptText = [TRANSCRIPTION_INSTRUCTIONS, chunkNote, `Media context: ${contextHint}`]
    .filter(Boolean)
    .join('\n\n');

  return generateStructuredTranscriptWithRetry(ai, [
    {
      inlineData: {
        mimeType,
        data: buffer.toString('base64'),
      },
    },
    { text: promptText },
  ]);
}

async function transcribeWithGeminiFilePath(
  ai: GoogleGenAI,
  filePath: string,
  mimeType: string,
  contextHint: string,
  durationHintSeconds?: number,
  onProgress?: ProgressUpdater
): Promise<RawTranscriptPayload> {
  const fileStat = await fs.stat(filePath);

  // For MP3 or M4A audio > 8 minutes or > 8 MB, split cleanly with zero-reencode ffmpeg -c copy
  const isSegmentableAudio = mimeType === 'audio/mpeg' || mimeType === 'audio/mp4';
  const segmentExt = mimeType === 'audio/mp4' ? '.m4a' : '.mp3';
  if (
    isSegmentableAudio &&
    ((durationHintSeconds && durationHintSeconds > 480) || fileStat.size > 8 * 1024 * 1024)
  ) {
    const chunkDir = path.join(os.tmpdir(), `cuescript_chunks_${crypto.randomBytes(6).toString('hex')}`);
    await fs.mkdir(chunkDir, { recursive: true });
    try {
      await execFileAsync(
        FFMPEG_BIN,
        [
          '-nostats',
          '-loglevel',
          'error',
          '-y',
          '-i',
          filePath,
          '-vn',
          '-f',
          'segment',
          '-segment_time',
          String(CHUNK_DURATION_SECONDS),
          '-reset_timestamps',
          '1',
          '-c',
          'copy',
          path.join(chunkDir, `chunk_%03d${segmentExt}`),
        ],
        { timeout: 45000 }
      );

      const chunkFiles = (await fs.readdir(chunkDir))
        .filter((f) => f.endsWith(segmentExt))
        .sort();

      if (chunkFiles.length > 1) {
        const chunkPayloads: Array<{ offset: number; payload: RawTranscriptPayload }> = new Array(
          chunkFiles.length
        );
        const concurrency = 2;
        let nextIndex = 0;
        let completedChunks = 0;

        onProgress?.(
          2,
          `Transcribing ${chunkFiles.length} audio segments in parallel (0 / ${chunkFiles.length})...`,
          34
        );

        async function worker() {
          while (nextIndex < chunkFiles.length) {
            const idx = nextIndex++;
            const chunkPath = path.join(chunkDir, chunkFiles[idx]);
            const buf = await fs.readFile(chunkPath);
            const offset = idx * CHUNK_DURATION_SECONDS;
            const payload = await transcribeSingleInlineChunk(ai, buf, mimeType, contextHint, {
              index: idx,
              total: chunkFiles.length,
              offsetSeconds: offset,
            });
            chunkPayloads[idx] = { offset, payload };
            completedChunks += 1;
            const pct = 34 + Math.round((completedChunks / chunkFiles.length) * 58);
            onProgress?.(
              2,
              `Transcribing audio (${completedChunks} / ${chunkFiles.length} segments done)...`,
              pct
            );
          }
        }

        await Promise.all(Array.from({ length: Math.min(concurrency, chunkFiles.length) }, () => worker()));

        onProgress?.(3, 'Merging timestamps, speaker labels & chapters...', 95);

        const mergedSegments: RawSegment[] = [];
        const mergedChapters: RawChapter[] = [];
        const summaries: string[] = [];
        let detectedLanguage = 'Unknown';
        let detectedTitle = '';

        for (const item of chunkPayloads) {
          if (!item) continue;
          const { offset, payload } = item;
          if (!detectedTitle && payload.title) detectedTitle = payload.title;
          if (detectedLanguage === 'Unknown' && payload.language) detectedLanguage = payload.language;
          if (payload.summary) summaries.push(payload.summary.trim());

          for (const seg of payload.segments ?? []) {
            if (!seg.text?.trim()) continue;
            const start = Math.max(0, Number(seg.startSeconds) || 0) + offset;
            const end = Math.max(start + 1, (Number(seg.endSeconds) || start + 4) + offset);
            mergedSegments.push({
              startSeconds: start,
              endSeconds: end,
              speakerId: seg.speakerId || 'Speaker 1',
              text: seg.text.trim(),
            });
          }

          for (const ch of payload.chapters ?? []) {
            if (!ch.title?.trim()) continue;
            const start = Math.max(0, Number(ch.startSeconds) || 0) + offset;
            const end = Math.max(start + 1, (Number(ch.endSeconds) || start + 60) + offset);
            mergedChapters.push({
              title: ch.title.trim(),
              startSeconds: start,
              endSeconds: end,
              summary: (ch.summary || '').trim(),
            });
          }
        }

        return {
          title: detectedTitle || 'Transcribed Recording',
          language: detectedLanguage,
          durationSeconds:
            durationHintSeconds ||
            (mergedSegments.length > 0 ? mergedSegments[mergedSegments.length - 1].endSeconds : 0),
          summary: summaries.slice(0, 2).join(' '),
          chapters: mergedChapters,
          segments: mergedSegments,
        };
      }
    } finally {
      await fs.rm(chunkDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  onProgress?.(2, 'Transcribing speech & diarizing speakers...', 55);

  if (fileStat.size <= INLINE_MEDIA_LIMIT_BYTES) {
    const buffer = await fs.readFile(filePath);
    return transcribeSingleInlineChunk(ai, buffer, mimeType, contextHint);
  }

  let uploadedFileName: string | undefined;
  try {
    let uploaded = await ai.files.upload({
      file: filePath,
      config: { mimeType },
    });
    uploadedFileName = uploaded.name;

    let attempts = 0;
    while (uploaded.state === 'PROCESSING' && attempts < 30 && uploaded.name) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      uploaded = await ai.files.get({ name: uploaded.name });
      attempts += 1;
    }

    if (uploaded.state === 'FAILED' || !uploaded.uri) {
      throw new Error('Gemini file processing failed for the extracted audio.');
    }

    const promptText = [TRANSCRIPTION_INSTRUCTIONS, `Media context: ${contextHint}`].join('\n\n');
    return await generateStructuredTranscriptWithRetry(ai, [
      {
        fileData: {
          fileUri: uploaded.uri,
          mimeType: uploaded.mimeType || mimeType,
        },
      },
      { text: promptText },
    ]);
  } finally {
    if (uploadedFileName) {
      await ai.files.delete({ name: uploadedFileName }).catch(() => {});
    }
  }
}

interface GroqVerboseSegment {
  id?: number;
  start?: number;
  end?: number;
  text?: string;
}

interface GroqVerboseResponse {
  text?: string;
  language?: string;
  duration?: number;
  segments?: GroqVerboseSegment[];
}

function isTransientGroqError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429 || (typeof status === 'number' && status >= 500)) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /429|rate.?limit|500|502|503|504|overloaded|ETIMEDOUT|ECONNRESET|fetch failed/i.test(msg);
}

async function probeAudioDuration(filePath: string): Promise<number | undefined> {
  // Primary: parse Duration from bundled static ffmpeg metadata probe (~15ms, zero ffprobe dependency)
  try {
    const { stderr } = await execFileAsync(FFMPEG_BIN, ['-hide_banner', '-i', filePath], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    const match = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
    if (match) {
      const total = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      if (Number.isFinite(total) && total > 0) {
        return Math.round(total);
      }
    }
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr || '';
    const match = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
    if (match) {
      const total = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      if (Number.isFinite(total) && total > 0) {
        return Math.round(total);
      }
    }
  }

  // Optional fallback: system ffprobe if available
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      { timeout: 10000 }
    );
    const probed = Number(stdout.trim());
    if (Number.isFinite(probed) && probed > 0) {
      return Math.round(probed);
    }
  } catch {
    // Optional probe fallback
  }
  return undefined;
}

async function normalizeFileToSpeechAudio(inputPath: string): Promise<{
  audioPath: string;
  ext: string;
  durationSeconds?: number;
}> {
  // First try instant stream-copy audio extraction to .m4a (0 re-encoding)
  const m4aPath = path.join(os.tmpdir(), `cuescript_groq_${crypto.randomBytes(6).toString('hex')}.m4a`);
  try {
    await execFileAsync(
      FFMPEG_BIN,
      ['-nostats', '-loglevel', 'error', '-y', '-i', inputPath, '-vn', '-c:a', 'copy', m4aPath],
      { timeout: 45000, maxBuffer: 4 * 1024 * 1024 }
    );
    const stat = await fs.stat(m4aPath);
    if (stat.size > 0) {
      const durationSeconds = await probeAudioDuration(m4aPath);
      return { audioPath: m4aPath, ext: '.m4a', durationSeconds };
    }
    await fs.unlink(m4aPath).catch(() => {});
  } catch {
    await fs.unlink(m4aPath).catch(() => {});
  }

  // Fallback: fast 16 kHz mono 32 kbps MP3 transcode
  const mp3Path = path.join(os.tmpdir(), `cuescript_groq_${crypto.randomBytes(6).toString('hex')}.mp3`);
  await execFileAsync(
    FFMPEG_BIN,
    [
      '-nostats',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '32k',
      '-compression_level',
      '0',
      mp3Path,
    ],
    { timeout: 300000, maxBuffer: 4 * 1024 * 1024 }
  );
  const durationSeconds = await probeAudioDuration(mp3Path);
  return { audioPath: mp3Path, ext: '.mp3', durationSeconds };
}

async function callGroqWhisperSingleFile(groq: Groq, filePath: string): Promise<GroqVerboseResponse> {
  const retryDelaysMs = [0, 3500, 9000];
  let lastErr: unknown;

  for (let i = 0; i < retryDelaysMs.length; i += 1) {
    if (retryDelaysMs[i] > 0) {
      const status = (lastErr as { status?: number })?.status;
      const delayMs = status === 429 ? Math.max(retryDelaysMs[i], 9000) : retryDelaysMs[i];
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const transcription = await groq.audio.transcriptions.create({
        file: createReadStream(filePath),
        model: GROQ_WHISPER_MODEL,
        temperature: 0,
        response_format: 'verbose_json',
      });
      return transcription as unknown as GroqVerboseResponse;
    } catch (err) {
      lastErr = err;
      if (!isTransientGroqError(err)) {
        throw err;
      }
    }
  }
  throw lastErr;
}

function coalesceGroqSegments(
  rawSegments: GroqVerboseSegment[],
  fallbackText: string | undefined,
  fallbackDuration: number,
  offsetSeconds: number
): RawSegment[] {
  const cleaned = rawSegments
    .filter((s) => typeof s.text === 'string' && s.text.trim().length > 0)
    .map((s) => {
      const start = Math.max(0, Number(s.start) || 0) + offsetSeconds;
      const rawEnd = Math.max(start + 0.5, (Number(s.end) || start + 2) + offsetSeconds);
      return {
        startSeconds: Number(start.toFixed(2)),
        endSeconds: Number(rawEnd.toFixed(2)),
        text: (s.text || '').trim().replace(/\s+/g, ' '),
      };
    });

  if (cleaned.length === 0) {
    const trimmed = (fallbackText || '').trim();
    if (!trimmed) return [];
    return [
      {
        startSeconds: Number(offsetSeconds.toFixed(2)),
        endSeconds: Number((offsetSeconds + Math.max(2, fallbackDuration)).toFixed(2)),
        speakerId: 'Speaker 1',
        text: trimmed,
      },
    ];
  }

  // Merge very short Whisper fragments into readable 4–12s subtitle segments
  const merged: RawSegment[] = [];
  let current: { startSeconds: number; endSeconds: number; text: string } | null = null;

  for (const seg of cleaned) {
    if (!current) {
      current = { ...seg };
      continue;
    }

    const gap = seg.startSeconds - current.endSeconds;
    const combinedDuration = seg.endSeconds - current.startSeconds;
    const combinedChars = current.text.length + 1 + seg.text.length;
    const endsSentence = /[.?!।]["']?$/.test(current.text);
    const currentDuration = current.endSeconds - current.startSeconds;

    const shouldFlush =
      gap > 1.8 ||
      combinedDuration > 12 ||
      combinedChars > 220 ||
      (endsSentence && currentDuration >= 4.2);

    if (shouldFlush) {
      merged.push({
        startSeconds: current.startSeconds,
        endSeconds: current.endSeconds,
        speakerId: 'Speaker 1',
        text: current.text,
      });
      current = { ...seg };
    } else {
      current.endSeconds = Math.max(current.endSeconds, seg.endSeconds);
      current.text = `${current.text} ${seg.text}`.trim();
    }
  }

  if (current) {
    merged.push({
      startSeconds: current.startSeconds,
      endSeconds: current.endSeconds,
      speakerId: 'Speaker 1',
      text: current.text,
    });
  }

  return merged;
}

function buildHeuristicChaptersAndSummary(
  segments: RawSegment[],
  durationSeconds: number,
  fallbackTitle?: string
): { title: string; summary: string; chapters: RawChapter[] } {
  const safeDuration = Math.max(
    durationSeconds,
    segments.length > 0 ? Number(segments[segments.length - 1].endSeconds) || 0 : 0
  );

  if (segments.length === 0) {
    return {
      title: fallbackTitle || 'Transcribed Recording',
      summary: 'Audio processed with Groq Whisper (whisper-large-v3). No spoken dialogue was detected.',
      chapters: [],
    };
  }

  const chapterCount =
    safeDuration < 45 || segments.length < 4
      ? 1
      : Math.min(6, Math.max(2, Math.round(safeDuration / 480) + 1));

  const perChapter = Math.max(1, Math.ceil(segments.length / chapterCount));
  const chapters: RawChapter[] = [];

  for (let c = 0; c < chapterCount; c += 1) {
    const startIdx = c * perChapter;
    if (startIdx >= segments.length) break;
    const slice = segments.slice(startIdx, Math.min(segments.length, startIdx + perChapter));
    if (slice.length === 0) continue;

    const chStart = Number(slice[0].startSeconds) || 0;
    const chEnd = Number(slice[slice.length - 1].endSeconds) || Math.max(chStart + 1, safeDuration);
    const joinedText = slice.map((s) => s.text || '').join(' ').trim();
    const firstSentence = joinedText.split(/(?<=[.?!।])\s+/)[0] || joinedText;
    const summaryText =
      firstSentence.length > 165 ? `${firstSentence.slice(0, 162).trim()}...` : firstSentence;

    const titleWords = firstSentence
      .replace(/^["'“”(\s]+/, '')
      .split(/\s+/)
      .slice(0, 7)
      .join(' ')
      .replace(/[,:;—-]+$/, '');
    const chapterTitle =
      chapterCount === 1
        ? 'Full Recording'
        : `Part ${chapters.length + 1}: ${titleWords || 'Discussion'}`;

    chapters.push({
      title: chapterTitle.length > 64 ? `${chapterTitle.slice(0, 61)}...` : chapterTitle,
      startSeconds: chStart,
      endSeconds: Math.max(chStart + 1, chEnd),
      summary: summaryText,
    });
  }

  const opener = segments
    .slice(0, 3)
    .map((s) => s.text || '')
    .join(' ')
    .trim();
  const midpoint =
    segments.length > 6
      ? (segments[Math.floor(segments.length / 2)].text || '').trim()
      : '';
  const rawSummary = [opener, midpoint].filter(Boolean).join(' ');
  const summary =
    rawSummary.length > 320 ? `${rawSummary.slice(0, 317).trim()}...` : rawSummary;

  return {
    title: fallbackTitle || chapters[0]?.title || 'Transcribed Recording',
    summary: summary || 'Verbatim transcript generated with Groq Whisper (whisper-large-v3).',
    chapters,
  };
}

const CHAPTER_ENRICHMENT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: 'Concise descriptive title for the recording.' },
    summary: { type: Type.STRING, description: '2 to 3 sentence executive summary of the transcript.' },
    chapters: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: 'Short chapter title (3-8 words).' },
          startSeconds: { type: Type.NUMBER, description: 'Chapter start timestamp in seconds.' },
          endSeconds: { type: Type.NUMBER, description: 'Chapter end timestamp in seconds.' },
          summary: { type: Type.STRING, description: 'One-sentence chapter summary.' },
        },
        required: ['title', 'startSeconds', 'endSeconds', 'summary'],
      },
    },
  },
  required: ['title', 'summary', 'chapters'],
};

async function enrichChaptersWithGeminiText(
  segments: RawSegment[],
  durationSeconds: number,
  language: string,
  contextHint: string
): Promise<{ title?: string; summary?: string; chapters?: RawChapter[] } | null> {
  if (!hasGeminiApiKey() || segments.length < 3) {
    return null;
  }

  try {
    const ai = getGeminiClient();
    // Build a compact sampled timeline (max ~10,000 chars) so text enrichment is fast and cheap
    const maxLines = 120;
    const step = Math.max(1, Math.ceil(segments.length / maxLines));
    const sampledLines: string[] = [];
    let charBudget = 0;

    for (let i = 0; i < segments.length; i += step) {
      const seg = segments[i];
      const t = Math.round(Number(seg.startSeconds) || 0);
      const line = `[${t}s] ${(seg.text || '').trim()}`;
      if (charBudget + line.length > 10000) break;
      sampledLines.push(line);
      charBudget += line.length + 1;
    }

    const prompt = [
      'Given this timestamped transcript excerpt, produce a concise title, a 2-3 sentence executive summary, and 2 to 6 chronological topic chapters with accurate startSeconds and endSeconds.',
      `Total duration: ${Math.round(durationSeconds)} seconds. Language: ${language}.`,
      `Context: ${contextHint}`,
      'Write the title, summary, and chapter labels in English (or the primary language if more natural).',
      '',
      sampledLines.join('\n'),
    ].join('\n');

    const response = await Promise.race([
      ai.models.generateContent({
        model: GEMINI_FALLBACK_MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: CHAPTER_ENRICHMENT_SCHEMA,
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('ENRICHMENT_TIMEOUT')), 14000)
      ),
    ]);

    const parsed = parseGeminiJson(response.text);
    if (Array.isArray(parsed.chapters) && parsed.chapters.length > 0) {
      return {
        title: parsed.title,
        summary: parsed.summary,
        chapters: parsed.chapters,
      };
    }
    return null;
  } catch {
    // Best-effort only: never fail a completed Groq transcription
    return null;
  }
}

async function transcribeAudioFileWithGroq(
  groq: Groq,
  filePath: string,
  mimeType: string,
  contextHint: string,
  durationHintSeconds?: number,
  onProgress?: ProgressUpdater
): Promise<RawTranscriptPayload> {
  let workingPath = filePath;
  let workingExt = path.extname(filePath).toLowerCase() || '.m4a';
  let cleanupAudioPath: string | null = null;
  let effectiveDuration = durationHintSeconds;

  const isDirectGroqAudio =
    mimeType === 'audio/mp4' ||
    mimeType === 'audio/mpeg' ||
    mimeType === 'audio/wav' ||
    mimeType === 'audio/ogg' ||
    mimeType === 'audio/flac';

  if (!isDirectGroqAudio) {
    onProgress?.(1, 'Extracting audio track for Groq Whisper...', 26);
    const normalized = await normalizeFileToSpeechAudio(filePath);
    workingPath = normalized.audioPath;
    workingExt = normalized.ext;
    cleanupAudioPath = normalized.audioPath;
    if (!effectiveDuration && normalized.durationSeconds) {
      effectiveDuration = normalized.durationSeconds;
    }
  } else if (!effectiveDuration) {
    effectiveDuration = await probeAudioDuration(workingPath);
  }

  try {
    const workingStat = await fs.stat(workingPath);
    const shouldChunk =
      workingStat.size > GROQ_MAX_SINGLE_FILE_BYTES ||
      (effectiveDuration !== undefined && effectiveDuration > GROQ_CHUNK_DURATION_SECONDS + 120);

    let allSegments: RawSegment[] = [];
    let detectedLanguage = 'Unknown';
    let measuredDuration = effectiveDuration || 0;

    if (shouldChunk) {
      const chunkDir = path.join(os.tmpdir(), `cuescript_groq_chunks_${crypto.randomBytes(6).toString('hex')}`);
      await fs.mkdir(chunkDir, { recursive: true });
      try {
        await execFileAsync(
          FFMPEG_BIN,
          [
            '-nostats',
            '-loglevel',
            'error',
            '-y',
            '-i',
            workingPath,
            '-vn',
            '-f',
            'segment',
            '-segment_time',
            String(GROQ_CHUNK_DURATION_SECONDS),
            '-reset_timestamps',
            '1',
            '-c',
            'copy',
            path.join(chunkDir, `chunk_%03d${workingExt}`),
          ],
          { timeout: 45000 }
        );

        const chunkFiles = (await fs.readdir(chunkDir))
          .filter((f) => f.endsWith(workingExt))
          .sort();

        const chunkResults: Array<{
          offset: number;
          response: GroqVerboseResponse;
          chunkDuration: number;
        }> = new Array(chunkFiles.length);

        const concurrency = 2;
        let nextIndex = 0;
        let completed = 0;

        onProgress?.(
          2,
          `Transcribing ${chunkFiles.length} audio segments with Groq Whisper (0 / ${chunkFiles.length})...`,
          34
        );

        async function worker() {
          while (nextIndex < chunkFiles.length) {
            const idx = nextIndex++;
            const chunkPath = path.join(chunkDir, chunkFiles[idx]);
            const offset = idx * GROQ_CHUNK_DURATION_SECONDS;
            const res = await callGroqWhisperSingleFile(groq, chunkPath);
            const chunkDur = Number(res.duration) || GROQ_CHUNK_DURATION_SECONDS;
            chunkResults[idx] = { offset, response: res, chunkDuration: chunkDur };
            completed += 1;
            const pct = 34 + Math.round((completed / chunkFiles.length) * 54);
            onProgress?.(
              2,
              `Transcribing with Groq Whisper (${completed} / ${chunkFiles.length} segments done)...`,
              pct
            );
          }
        }

        await Promise.all(
          Array.from({ length: Math.min(concurrency, chunkFiles.length) }, () => worker())
        );

        let runningOffset = 0;
        for (const item of chunkResults) {
          if (!item) continue;
          if (detectedLanguage === 'Unknown' && item.response.language) {
            detectedLanguage = item.response.language;
          }
          const segs = coalesceGroqSegments(
            Array.isArray(item.response.segments) ? item.response.segments : [],
            item.response.text,
            item.chunkDuration,
            runningOffset
          );
          allSegments.push(...segs);
          runningOffset += item.chunkDuration;
        }
        measuredDuration = Math.max(measuredDuration, runningOffset);
      } finally {
        await fs.rm(chunkDir, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      onProgress?.(2, 'Transcribing speech with Groq Whisper (whisper-large-v3)...', 52);
      const res = await callGroqWhisperSingleFile(groq, workingPath);
      if (res.language) detectedLanguage = res.language;
      const dur = Number(res.duration) || measuredDuration || 0;
      measuredDuration = Math.max(measuredDuration, dur);
      allSegments = coalesceGroqSegments(
        Array.isArray(res.segments) ? res.segments : [],
        res.text,
        dur,
        0
      );
    }

    onProgress?.(3, 'Building chapter timeline & exports...', 92);
    const heuristic = buildHeuristicChaptersAndSummary(allSegments, measuredDuration);
    const enriched = await enrichChaptersWithGeminiText(
      allSegments,
      measuredDuration,
      detectedLanguage,
      contextHint
    );

    const formattedLang =
      detectedLanguage && detectedLanguage !== 'Unknown'
        ? detectedLanguage.charAt(0).toUpperCase() + detectedLanguage.slice(1)
        : 'Unknown';

    return {
      title: enriched?.title || heuristic.title,
      language: formattedLang,
      durationSeconds: Math.round(measuredDuration),
      summary: enriched?.summary || heuristic.summary,
      chapters: enriched?.chapters || heuristic.chapters,
      segments: allSegments,
    };
  } finally {
    if (cleanupAudioPath) {
      await fs.unlink(cleanupAudioPath).catch(() => {});
    }
  }
}

interface DeepgramWord {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
  speaker?: number;
}

interface DeepgramUtterance {
  start?: number;
  end?: number;
  transcript?: string;
  speaker?: number;
}

interface DeepgramSentence {
  text?: string;
  start?: number;
  end?: number;
}

interface DeepgramParagraph {
  speaker?: number;
  sentences?: DeepgramSentence[];
}

interface DeepgramListenResponse {
  metadata?: {
    duration?: number;
  };
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{
        transcript?: string;
        words?: DeepgramWord[];
        paragraphs?: {
          paragraphs?: DeepgramParagraph[];
        };
      }>;
    }>;
    utterances?: DeepgramUtterance[];
  };
}

const ISO_LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  ar: 'Arabic',
  nl: 'Dutch',
  tr: 'Turkish',
  pl: 'Polish',
  sv: 'Swedish',
  id: 'Indonesian',
  vi: 'Vietnamese',
  th: 'Thai',
  ta: 'Tamil',
  te: 'Telugu',
  bn: 'Bengali',
  mr: 'Marathi',
  gu: 'Gujarati',
  pa: 'Punjabi',
  ur: 'Urdu',
  multi: 'Multilingual',
};

function formatLanguageLabel(rawCode: string | undefined): string {
  if (!rawCode) return 'Unknown';
  const cleaned = rawCode.trim();
  if (!cleaned || cleaned.toLowerCase() === 'unknown') return 'Unknown';
  const base = cleaned.toLowerCase().split(/[-_]/)[0];
  if (ISO_LANGUAGE_NAMES[base]) {
    return ISO_LANGUAGE_NAMES[base];
  }
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function isTransientDeepgramError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429 || (typeof status === 'number' && status >= 500)) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /429|rate.?limit|500|502|503|504|overloaded|ETIMEDOUT|ECONNRESET|TimeoutError|fetch failed/i.test(msg);
}

async function callDeepgramSingleFile(
  apiKey: string,
  filePath: string,
  mimeType: string
): Promise<DeepgramListenResponse> {
  const params = new URLSearchParams({
    model: DEEPGRAM_MODEL,
    detect_language: 'true',
    smart_format: 'true',
    punctuate: 'true',
    diarize: 'true',
    utterances: 'true',
    paragraphs: 'true',
  });
  const endpointUrl = `${DEEPGRAM_LISTEN_ENDPOINT}?${params.toString()}`;
  const audioBuffer = await fs.readFile(filePath);
  const contentType = mimeType && mimeType.includes('/') ? mimeType : 'audio/mp4';

  const retryDelaysMs = [0, 3500, 9000];
  let lastErr: unknown;

  for (let i = 0; i < retryDelaysMs.length; i += 1) {
    if (retryDelaysMs[i] > 0) {
      const status = (lastErr as { status?: number })?.status;
      const delayMs = status === 429 ? Math.max(retryDelaysMs[i], 9000) : retryDelaysMs[i];
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const response = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': contentType,
        },
        body: audioBuffer,
        signal: AbortSignal.timeout(180000),
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        const err = new Error(
          `Deepgram HTTP ${response.status}: ${errBody.slice(0, 180) || response.statusText}`
        ) as Error & { status?: number };
        err.status = response.status;
        throw err;
      }

      return (await response.json()) as DeepgramListenResponse;
    } catch (err) {
      lastErr = err;
      if (!isTransientDeepgramError(err)) {
        throw err;
      }
    }
  }
  throw lastErr;
}

function coalesceSpeakerAwareSegments(
  items: Array<{ startSeconds: number; endSeconds: number; speakerId: string; text: string }>
): RawSegment[] {
  const merged: RawSegment[] = [];
  let current: { startSeconds: number; endSeconds: number; speakerId: string; text: string } | null = null;

  for (const seg of items) {
    if (!current) {
      current = { ...seg };
      continue;
    }

    const sameSpeaker = seg.speakerId === current.speakerId;
    const gap = seg.startSeconds - current.endSeconds;
    const combinedDuration = seg.endSeconds - current.startSeconds;
    const combinedChars = current.text.length + 1 + seg.text.length;
    const endsSentence = /[.?!।]["']?$/.test(current.text);
    const currentDuration = current.endSeconds - current.startSeconds;

    const shouldFlush =
      !sameSpeaker ||
      gap > 1.8 ||
      combinedDuration > 12 ||
      combinedChars > 240 ||
      (endsSentence && currentDuration >= 4.2);

    if (shouldFlush) {
      merged.push({
        startSeconds: current.startSeconds,
        endSeconds: current.endSeconds,
        speakerId: current.speakerId,
        text: current.text,
      });
      current = { ...seg };
    } else {
      current.endSeconds = Math.max(current.endSeconds, seg.endSeconds);
      current.text = `${current.text} ${seg.text}`.trim();
    }
  }

  if (current) {
    merged.push({
      startSeconds: current.startSeconds,
      endSeconds: current.endSeconds,
      speakerId: current.speakerId,
      text: current.text,
    });
  }

  return merged;
}

function extractDeepgramSegments(
  dg: DeepgramListenResponse,
  fallbackDuration: number,
  offsetSeconds: number
): RawSegment[] {
  const utterances = dg.results?.utterances;
  if (Array.isArray(utterances) && utterances.length > 0) {
    const mapped = utterances
      .filter((u) => typeof u.transcript === 'string' && u.transcript.trim().length > 0)
      .map((u) => {
        const start = Math.max(0, Number(u.start) || 0) + offsetSeconds;
        const end = Math.max(start + 0.5, (Number(u.end) || start + 2) + offsetSeconds);
        const spkNum = typeof u.speaker === 'number' && Number.isFinite(u.speaker) ? u.speaker + 1 : 1;
        return {
          startSeconds: Number(start.toFixed(2)),
          endSeconds: Number(end.toFixed(2)),
          speakerId: `Speaker ${spkNum}`,
          text: (u.transcript || '').trim().replace(/\s+/g, ' '),
        };
      });
    if (mapped.length > 0) {
      return coalesceSpeakerAwareSegments(mapped);
    }
  }

  const alt = dg.results?.channels?.[0]?.alternatives?.[0];
  const paragraphs = alt?.paragraphs?.paragraphs;
  if (Array.isArray(paragraphs) && paragraphs.length > 0) {
    const mapped: Array<{ startSeconds: number; endSeconds: number; speakerId: string; text: string }> = [];
    for (const para of paragraphs) {
      const spkNum = typeof para.speaker === 'number' && Number.isFinite(para.speaker) ? para.speaker + 1 : 1;
      for (const sent of para.sentences ?? []) {
        const text = (sent.text || '').trim().replace(/\s+/g, ' ');
        if (!text) continue;
        const start = Math.max(0, Number(sent.start) || 0) + offsetSeconds;
        const end = Math.max(start + 0.5, (Number(sent.end) || start + 2) + offsetSeconds);
        mapped.push({
          startSeconds: Number(start.toFixed(2)),
          endSeconds: Number(end.toFixed(2)),
          speakerId: `Speaker ${spkNum}`,
          text,
        });
      }
    }
    if (mapped.length > 0) {
      return coalesceSpeakerAwareSegments(mapped);
    }
  }

  const words = alt?.words;
  if (Array.isArray(words) && words.length > 0) {
    const mapped = words
      .filter((w) => (w.punctuated_word || w.word || '').trim().length > 0)
      .map((w) => {
        const start = Math.max(0, Number(w.start) || 0) + offsetSeconds;
        const end = Math.max(start + 0.1, (Number(w.end) || start + 0.3) + offsetSeconds);
        const spkNum = typeof w.speaker === 'number' && Number.isFinite(w.speaker) ? w.speaker + 1 : 1;
        return {
          startSeconds: Number(start.toFixed(2)),
          endSeconds: Number(end.toFixed(2)),
          speakerId: `Speaker ${spkNum}`,
          text: (w.punctuated_word || w.word || '').trim(),
        };
      });
    if (mapped.length > 0) {
      return coalesceSpeakerAwareSegments(mapped);
    }
  }

  const fullText = (alt?.transcript || '').trim();
  if (!fullText) return [];
  return [
    {
      startSeconds: Number(offsetSeconds.toFixed(2)),
      endSeconds: Number((offsetSeconds + Math.max(2, fallbackDuration)).toFixed(2)),
      speakerId: 'Speaker 1',
      text: fullText,
    },
  ];
}

async function transcribeAudioFileWithDeepgram(
  apiKey: string,
  filePath: string,
  mimeType: string,
  contextHint: string,
  durationHintSeconds?: number,
  onProgress?: ProgressUpdater
): Promise<RawTranscriptPayload> {
  let workingPath = filePath;
  let workingMime = mimeType;
  let workingExt = path.extname(filePath).toLowerCase() || '.m4a';
  let cleanupAudioPath: string | null = null;
  let effectiveDuration = durationHintSeconds;

  const isDirectAudio =
    mimeType === 'audio/mp4' ||
    mimeType === 'audio/mpeg' ||
    mimeType === 'audio/wav' ||
    mimeType === 'audio/ogg' ||
    mimeType === 'audio/flac';

  if (!isDirectAudio) {
    onProgress?.(1, 'Extracting audio track for Deepgram Nova-3...', 28);
    const normalized = await normalizeFileToSpeechAudio(filePath);
    workingPath = normalized.audioPath;
    workingExt = normalized.ext;
    workingMime = normalized.ext === '.mp3' ? 'audio/mpeg' : 'audio/mp4';
    cleanupAudioPath = normalized.audioPath;
    if (!effectiveDuration && normalized.durationSeconds) {
      effectiveDuration = normalized.durationSeconds;
    }
  } else if (!effectiveDuration) {
    effectiveDuration = await probeAudioDuration(workingPath);
  }

  try {
    const workingStat = await fs.stat(workingPath);
    const shouldChunk = workingStat.size > DEEPGRAM_MAX_SINGLE_FILE_BYTES;

    let allSegments: RawSegment[] = [];
    let detectedLanguage = 'Unknown';
    let measuredDuration = effectiveDuration || 0;

    if (shouldChunk) {
      const chunkDir = path.join(os.tmpdir(), `cuescript_dg_chunks_${crypto.randomBytes(6).toString('hex')}`);
      await fs.mkdir(chunkDir, { recursive: true });
      try {
        await execFileAsync(
          FFMPEG_BIN,
          [
            '-nostats',
            '-loglevel',
            'error',
            '-y',
            '-i',
            workingPath,
            '-vn',
            '-f',
            'segment',
            '-segment_time',
            String(DEEPGRAM_CHUNK_DURATION_SECONDS),
            '-reset_timestamps',
            '1',
            '-c',
            'copy',
            path.join(chunkDir, `chunk_%03d${workingExt}`),
          ],
          { timeout: 45000 }
        );

        const chunkFiles = (await fs.readdir(chunkDir))
          .filter((f) => f.endsWith(workingExt))
          .sort();

        const chunkResults: Array<{
          response: DeepgramListenResponse;
          chunkDuration: number;
        }> = new Array(chunkFiles.length);

        const concurrency = 2;
        let nextIndex = 0;
        let completed = 0;

        onProgress?.(
          2,
          `Transcribing ${chunkFiles.length} audio segments with Deepgram Nova-3 (0 / ${chunkFiles.length})...`,
          38
        );

        async function worker() {
          while (nextIndex < chunkFiles.length) {
            const idx = nextIndex++;
            const chunkPath = path.join(chunkDir, chunkFiles[idx]);
            const res = await callDeepgramSingleFile(apiKey, chunkPath, workingMime);
            const chunkDur = Number(res.metadata?.duration) || DEEPGRAM_CHUNK_DURATION_SECONDS;
            chunkResults[idx] = { response: res, chunkDuration: chunkDur };
            completed += 1;
            const pct = 38 + Math.round((completed / chunkFiles.length) * 50);
            onProgress?.(
              2,
              `Transcribing with Deepgram Nova-3 (${completed} / ${chunkFiles.length} segments done)...`,
              pct
            );
          }
        }

        await Promise.all(
          Array.from({ length: Math.min(concurrency, chunkFiles.length) }, () => worker())
        );

        let runningOffset = 0;
        for (const item of chunkResults) {
          if (!item) continue;
          const lang = item.response.results?.channels?.[0]?.detected_language;
          if (detectedLanguage === 'Unknown' && lang) {
            detectedLanguage = lang;
          }
          const segs = extractDeepgramSegments(item.response, item.chunkDuration, runningOffset);
          allSegments.push(...segs);
          runningOffset += item.chunkDuration;
        }
        measuredDuration = Math.max(measuredDuration, runningOffset);
      } finally {
        await fs.rm(chunkDir, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      onProgress?.(2, `Transcribing speech & diarizing speakers with Deepgram (${DEEPGRAM_MODEL})...`, 54);
      const res = await callDeepgramSingleFile(apiKey, workingPath, workingMime);
      const lang = res.results?.channels?.[0]?.detected_language;
      if (lang) detectedLanguage = lang;
      const dur = Number(res.metadata?.duration) || measuredDuration || 0;
      measuredDuration = Math.max(measuredDuration, dur);
      allSegments = extractDeepgramSegments(res, dur, 0);
    }

    onProgress?.(3, 'Building chapter timeline & exports...', 92);
    const formattedLang = formatLanguageLabel(detectedLanguage);
    const heuristic = buildHeuristicChaptersAndSummary(allSegments, measuredDuration);
    const enriched = await enrichChaptersWithGeminiText(
      allSegments,
      measuredDuration,
      formattedLang,
      contextHint
    );

    return {
      title: enriched?.title || heuristic.title,
      language: formattedLang,
      durationSeconds: Math.round(measuredDuration),
      summary: enriched?.summary || heuristic.summary,
      chapters: enriched?.chapters || heuristic.chapters,
      segments: allSegments,
    };
  } finally {
    if (cleanupAudioPath) {
      await fs.unlink(cleanupAudioPath).catch(() => {});
    }
  }
}

async function transcribeFileWithGroqPrimaryOrGeminiFallback(params: {
  filePath: string;
  mimeType: string;
  contextHint: string;
  durationHintSeconds?: number;
  onProgress?: ProgressUpdater;
}): Promise<{ payload: RawTranscriptPayload; engineLabel: string }> {
  const groq = getGroqClient();
  const deepgramKey = getDeepgramApiKey();
  let groqFailed = false;
  let deepgramFailed = false;

  // Tier 1: Groq Whisper (whisper-large-v3)
  if (groq) {
    try {
      const payload = await transcribeAudioFileWithGroq(
        groq,
        params.filePath,
        params.mimeType,
        params.contextHint,
        params.durationHintSeconds,
        params.onProgress
      );
      return { payload, engineLabel: `Groq Whisper (${GROQ_WHISPER_MODEL})` };
    } catch (err) {
      groqFailed = true;
      const safeReason = err instanceof Error ? err.message.slice(0, 140) : 'unknown error';
      console.warn(`Groq Whisper transcription failed (${safeReason}); trying next fallback.`);
      params.onProgress?.(
        2,
        deepgramKey
          ? 'Groq unavailable — switching to Deepgram Nova-3 fallback...'
          : 'Groq unavailable — switching to Google Gemini fallback...',
        36
      );
    }
  }

  // Tier 2: Deepgram (nova-3)
  if (deepgramKey) {
    try {
      const payload = await transcribeAudioFileWithDeepgram(
        deepgramKey,
        params.filePath,
        params.mimeType,
        params.contextHint,
        params.durationHintSeconds,
        params.onProgress
      );
      return {
        payload,
        engineLabel: groqFailed
          ? `Deepgram (${DEEPGRAM_MODEL}) fallback (after Groq error)`
          : `Deepgram (${DEEPGRAM_MODEL})`,
      };
    } catch (err) {
      deepgramFailed = true;
      const safeReason = err instanceof Error ? err.message.slice(0, 140) : 'unknown error';
      console.warn(`Deepgram Nova-3 transcription failed (${safeReason}); falling back to Google Gemini.`);
      params.onProgress?.(2, 'Deepgram unavailable — falling back to Google Gemini...', 40);
    }
  }

  // Tier 3: Google Gemini (last fallback)
  const ai = getGeminiClient();
  const payload = await transcribeWithGeminiFilePath(
    ai,
    params.filePath,
    params.mimeType,
    params.contextHint,
    params.durationHintSeconds,
    params.onProgress
  );
  const fallbackNote =
    groqFailed && deepgramFailed
      ? 'after Groq & Deepgram errors'
      : groqFailed
        ? 'after Groq error'
        : deepgramFailed
          ? 'after Deepgram error'
          : 'GROQ_API_KEY & DEEPGRAM_API_KEY not configured';
  return {
    payload,
    engineLabel: `Google Gemini final fallback (${fallbackNote})`,
  };
}

async function transcribeBufferWithGroqPrimaryOrGeminiFallback(params: {
  buffer: Buffer;
  mimeType: string;
  contextHint: string;
  onProgress?: ProgressUpdater;
}): Promise<{ payload: RawTranscriptPayload; engineLabel: string }> {
  const ext = params.mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
  const tempPath = path.join(os.tmpdir(), `cuescript_buf_${crypto.randomBytes(8).toString('hex')}.${ext}`);
  try {
    await fs.writeFile(tempPath, params.buffer);
    return await transcribeFileWithGroqPrimaryOrGeminiFallback({
      filePath: tempPath,
      mimeType: params.mimeType,
      contextHint: params.contextHint,
      onProgress: params.onProgress,
    });
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

function parseGeminiJson(rawText: string | undefined): RawTranscriptPayload {
  const cleaned = (rawText || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  if (!cleaned) {
    throw new Error('The transcription model returned an empty response.');
  }
  return JSON.parse(cleaned) as RawTranscriptPayload;
}

function formatGeminiError(err: unknown): { status: number; message: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === 'GEMINI_API_KEY_MISSING') {
    return {
      status: 500,
      message:
        'No active transcription key succeeded (Groq -> Deepgram -> Gemini). Configure GROQ_API_KEY, DEEPGRAM_API_KEY, or GEMINI_API_KEY in Settings > Secrets.',
    };
  }
  if (/PERMISSION_DENIED|API_KEY_INVALID|403|401/i.test(msg)) {
    return {
      status: 403,
      message:
        'The transcription API rejected the configured key. Please verify GROQ_API_KEY, DEEPGRAM_API_KEY, and GEMINI_API_KEY in Settings > Secrets.',
    };
  }
  if (/RESOURCE_EXHAUSTED|429/i.test(msg)) {
    return {
      status: 429,
      message:
        'Transcription API rate limit reached across configured engines (Groq -> Deepgram -> Gemini). Wait a moment before retrying.',
    };
  }
  if (/503|UNAVAILABLE|high demand/i.test(msg)) {
    return {
      status: 503,
      message:
        'The final fallback transcription model is temporarily experiencing high demand. Please retry in a few seconds.',
    };
  }
  return {
    status: 502,
    message: `Transcription request failed: ${msg}`,
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_MEDIA_BYTES,
  },
});

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    const groqConfigured = Boolean(getGroqClient());
    const deepgramConfigured = Boolean(getDeepgramApiKey());
    const geminiConfigured = hasGeminiApiKey();
    res.json({
      ok: true,
      primaryEngine: groqConfigured
        ? `groq:${GROQ_WHISPER_MODEL}`
        : deepgramConfigured
          ? `deepgram:${DEEPGRAM_MODEL}`
          : `gemini:${GEMINI_MODEL}`,
      fallbackChain: [
        { engine: `groq:${GROQ_WHISPER_MODEL}`, configured: groqConfigured },
        { engine: `deepgram:${DEEPGRAM_MODEL}`, configured: deepgramConfigured },
        { engine: `gemini:${GEMINI_MODEL}`, configured: geminiConfigured },
      ],
      groqConfigured,
      deepgramConfigured,
      fallbackModel: GEMINI_MODEL,
    });
  });

  app.get('/api/media/:mediaId', (req: Request, res: Response) => {
    const mediaId = req.params.mediaId;
    if (!mediaId || !/^[a-f0-9]+$/i.test(mediaId)) {
      res.status(400).end();
      return;
    }
    const entry = ephemeralMediaStore.get(mediaId);
    if (!entry || !existsSync(entry.filePath)) {
      res.status(404).end();
      return;
    }

    const stat = statSync(entry.filePath);
    const total = stat.size;
    const range = req.headers.range;

    res.setHeader('Content-Type', entry.mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=1800');

    if (range) {
      const match = range.match(/bytes=(\d*)-(\d*)/);
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
        if (start >= total || end < start) {
          res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
          return;
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Content-Length', String(end - start + 1));
        createReadStream(entry.filePath, { start, end }).pipe(res);
        return;
      }
    }

    res.setHeader('Content-Length', String(total));
    createReadStream(entry.filePath).pipe(res);
  });

  // --- Headless Personal Google Drive Bridge API ---
  app.get('/api/drive/status', async (req: Request, res: Response) => {
    const configured = isDriveBridgeConfigured();
    const requiresPasscode = isPasscodeRequired();
    const unlocked = isDriveRequestAuthorized(req);
    const configError = getBridgeConfigurationError();

    if (!configured) {
      res.json({
        ok: true,
        configured: false,
        requiresPasscode,
        unlocked,
        reachable: false,
        configError,
      });
      return;
    }

    if (!unlocked) {
      res.json({
        ok: true,
        configured: true,
        requiresPasscode: true,
        unlocked: false,
        reachable: true,
      });
      return;
    }

    const ping = await pingDriveBridge();
    res.json({
      ok: true,
      configured: true,
      requiresPasscode,
      unlocked: true,
      reachable: ping.ok,
      folderName: ping.folderName,
      audioCount: ping.audioCount,
      transcriptCount: ping.transcriptCount,
      videoFolderCount: ping.videoFolderCount,
      error: ping.ok ? undefined : ping.error,
    });
  });

  app.post('/api/drive/unlock', (req: Request, res: Response) => {
    if (!isPasscodeRequired()) {
      res.json({ ok: true, unlocked: true, token: mintOwnerSessionToken() });
      return;
    }
    const candidate = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
    if (!verifyOwnerPasscode(candidate)) {
      res.status(401).json({ ok: false, message: 'Incorrect passcode.' });
      return;
    }
    res.json({ ok: true, unlocked: true, token: mintOwnerSessionToken() });
  });

  app.get('/api/drive/setup-script', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      manifest: APPS_SCRIPT_MANIFEST_JSON,
      script: APPS_SCRIPT_BRIDGE_CODE,
    });
  });

  app.get('/api/drive/library', async (req: Request, res: Response) => {
    if (!isDriveBridgeConfigured()) {
      res.json({ ok: true, jobs: [] });
      return;
    }
    if (!isDriveRequestAuthorized(req)) {
      res.status(401).json({ ok: false, message: 'Personal Drive is locked.' });
      return;
    }
    try {
      const jobs = await listDriveLibrary(30);
      res.json({ ok: true, jobs });
    } catch (err) {
      res.status(502).json({
        ok: false,
        message: err instanceof Error ? err.message : 'Could not load Drive library.',
      });
    }
  });

  app.get('/api/drive/audio/:fileId', async (req: Request, res: Response) => {
    if (!isDriveBridgeConfigured()) {
      res.status(404).end();
      return;
    }
    if (!isDriveRequestAuthorized(req)) {
      res.status(401).json({ ok: false, message: 'Personal Drive is locked.' });
      return;
    }
    const fileId = req.params.fileId || '';
    if (!isValidDriveFileId(fileId)) {
      res.status(400).end();
      return;
    }
    try {
      const cached = await downloadDriveAudioToTemp(fileId);
      const stat = statSync(cached.filePath);
      const total = stat.size;
      const range = req.headers.range;

      res.setHeader('Content-Type', cached.mimeType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, max-age=1800');

      if (range) {
        const match = range.match(/bytes=(\d*)-(\d*)/);
        if (match) {
          const start = match[1] ? Number(match[1]) : 0;
          const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
          if (start >= total || end < start) {
            res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
            return;
          }
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
          res.setHeader('Content-Length', String(end - start + 1));
          createReadStream(cached.filePath, { start, end }).pipe(res);
          return;
        }
      }

      res.setHeader('Content-Length', String(total));
      createReadStream(cached.filePath).pipe(res);
    } catch (err) {
      console.warn('Drive audio proxy error:', err instanceof Error ? err.message : err);
      res.status(502).json({ ok: false, message: 'Could not stream Drive audio.' });
    }
  });

  app.put('/api/drive/transcripts/:sourceKey', async (req: Request, res: Response) => {
    if (!isDriveBridgeConfigured()) {
      res.status(400).json({ ok: false, message: 'Drive Bridge is not configured.' });
      return;
    }
    if (!isDriveRequestAuthorized(req)) {
      res.status(401).json({ ok: false, message: 'Personal Drive is locked.' });
      return;
    }
    const sourceKey = req.params.sourceKey || '';
    if (!isValidSourceKey(sourceKey)) {
      res.status(400).json({ ok: false, message: 'Invalid sourceKey.' });
      return;
    }
    const job = req.body?.job as DriveJobPayload | undefined;
    if (!job || typeof job.title !== 'string' || !Array.isArray(job.segments)) {
      res.status(400).json({ ok: false, message: 'Invalid transcript payload.' });
      return;
    }
    try {
      const saved = await saveTranscriptBundleToDrive(sourceKey, {
        ...job,
        sourceKey,
        loadedFromCache: false,
      });
      res.json({
        ok: true,
        driveFolderId: saved.folderId,
        driveFolderName: saved.folderName,
        transcriptFiles: saved.transcriptFiles,
        syncedAt: saved.syncedAt,
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        message: err instanceof Error ? err.message : 'Could not update transcript in Drive.',
      });
    }
  });

  app.delete('/api/drive/transcripts/:sourceKey', async (req: Request, res: Response) => {
    if (!isDriveBridgeConfigured()) {
      res.status(400).json({ ok: false, message: 'Drive Bridge is not configured.' });
      return;
    }
    if (!isDriveRequestAuthorized(req)) {
      res.status(401).json({ ok: false, message: 'Personal Drive is locked.' });
      return;
    }
    const sourceKey = req.params.sourceKey || '';
    if (!isValidSourceKey(sourceKey)) {
      res.status(400).json({ ok: false, message: 'Invalid sourceKey.' });
      return;
    }
    try {
      const result = await trashDriveEntry(sourceKey);
      res.json({ ok: true, trashedCount: result.trashedCount });
    } catch (err) {
      res.status(502).json({
        ok: false,
        message: err instanceof Error ? err.message : 'Could not move Drive files to Trash.',
      });
    }
  });

  async function archiveJobToDriveIfEnabled(params: {
    driveEnabled: boolean;
    sourceKey: string;
    job: ReturnType<typeof normalizeTranscriptResult>;
    audioPath?: string;
    audioBuffer?: Buffer;
    audioMimeType?: string;
    existingDriveAudioFileId?: string;
    existingDriveAudioMimeType?: string;
    onProgress?: ProgressUpdater;
  }): Promise<ReturnType<typeof normalizeTranscriptResult>> {
    const jobWithKey = {
      ...params.job,
      sourceKey: params.sourceKey,
    };

    if (!params.driveEnabled || !isDriveBridgeConfigured()) {
      return jobWithKey;
    }

    let driveAudioFileId = params.existingDriveAudioFileId || jobWithKey.driveAudioFileId;
    let driveAudioMimeType = params.existingDriveAudioMimeType || jobWithKey.driveAudioMimeType;
    let driveFolderId = jobWithKey.driveFolderId;
    let driveFolderName =
      jobWithKey.driveFolderName ||
      formatDriveVideoFolderName(jobWithKey.sourceType, jobWithKey.title);
    let tempAudioPath: string | null = null;

    try {
      params.onProgress?.(3, 'Saving video folder (audio & transcripts) to Google Drive...', 96);

      if (!driveAudioFileId && (params.audioPath || params.audioBuffer)) {
        let pathToSave = params.audioPath;
        const mime = params.audioMimeType || 'audio/mp4';
        if (!pathToSave && params.audioBuffer) {
          const ext = mime.includes('mpeg') ? '.mp3' : mime.includes('wav') ? '.wav' : '.m4a';
          tempAudioPath = path.join(
            os.tmpdir(),
            `cuescript_drive_buf_${crypto.randomBytes(6).toString('hex')}${ext}`
          );
          await fs.writeFile(tempAudioPath, params.audioBuffer);
          pathToSave = tempAudioPath;
        }
        if (pathToSave) {
          try {
            const uploadedAudio = await saveAudioFileToDrive({
              sourceKey: params.sourceKey,
              audioPath: pathToSave,
              mimeType: mime,
              ffmpegBin: FFMPEG_BIN,
              sourceType: jobWithKey.sourceType,
              title: jobWithKey.title,
              folderName: driveFolderName,
            });
            driveAudioFileId = uploadedAudio.fileId;
            driveAudioMimeType = uploadedAudio.mimeType;
            if (uploadedAudio.folderId) driveFolderId = uploadedAudio.folderId;
            if (uploadedAudio.folderName) driveFolderName = uploadedAudio.folderName;
          } catch (audioErr) {
            console.warn(
              'Drive audio upload skipped:',
              audioErr instanceof Error ? audioErr.message : audioErr
            );
          }
        }
      }

      const enrichedJob = {
        ...jobWithKey,
        driveFolderId,
        driveFolderName,
        driveAudioFileId,
        driveAudioMimeType,
        ...(jobWithKey.mediaKind !== 'youtube' && driveAudioFileId
          ? {
              mediaKind: 'audio' as const,
              remoteMediaUrl: `/api/drive/audio/${driveAudioFileId}`,
            }
          : {}),
      };

      const savedBundle = await saveTranscriptBundleToDrive(params.sourceKey, enrichedJob);
      return {
        ...enrichedJob,
        driveFolderId: savedBundle.folderId || driveFolderId,
        driveFolderName: savedBundle.folderName || driveFolderName,
        driveTranscriptFileIds: savedBundle.transcriptFiles,
        syncedToDrive: true,
        loadedFromCache: false,
        syncedAt: savedBundle.syncedAt,
      };
    } catch (driveErr) {
      console.warn(
        'Drive transcript archive failed (returning local result):',
        driveErr instanceof Error ? driveErr.message : driveErr
      );
      return {
        ...jobWithKey,
        driveAudioFileId,
        driveAudioMimeType,
        syncedToDrive: false,
      };
    } finally {
      if (tempAudioPath) {
        await fs.unlink(tempAudioPath).catch(() => {});
      }
    }
  }

  interface AsyncJobRecord {
    asyncJobId: string;
    status: 'queued' | 'processing' | 'completed' | 'failed';
    stepIndex: number;
    stageLabel: string;
    progressPct: number;
    createdAt: number;
    job?: ReturnType<typeof normalizeTranscriptResult>;
    error?: {
      ok: false;
      code: string;
      platform?: Platform;
      title?: string;
      message: string;
      technicalReason?: string;
      suggestedAction?: string;
    };
  }

  const asyncJobs = new Map<string, AsyncJobRecord>();

  function createAsyncJob(initialLabel: string): AsyncJobRecord {
    const now = Date.now();
    for (const [id, rec] of asyncJobs.entries()) {
      if (now - rec.createdAt > 30 * 60 * 1000) asyncJobs.delete(id);
    }
    const asyncJobId = `async_${crypto.randomBytes(8).toString('hex')}`;
    const record: AsyncJobRecord = {
      asyncJobId,
      status: 'processing',
      stepIndex: 0,
      stageLabel: initialLabel,
      progressPct: 8,
      createdAt: now,
    };
    asyncJobs.set(asyncJobId, record);
    return record;
  }

  app.get('/api/jobs/:jobId', (req: Request, res: Response) => {
    const jobId = req.params.jobId || '';
    if (!/^async_[a-f0-9]+$/i.test(jobId)) {
      res.status(400).json({ ok: false, code: 'SERVER_ERROR', message: 'Invalid job identifier.' });
      return;
    }
    const rec = asyncJobs.get(jobId);
    if (!rec) {
      res.status(404).json({ ok: false, code: 'SERVER_ERROR', message: 'Job not found or expired.' });
      return;
    }
    res.json({
      ok: true,
      asyncJobId: rec.asyncJobId,
      status: rec.status,
      stepIndex: rec.stepIndex,
      stageLabel: rec.stageLabel,
      progressPct: rec.progressPct,
      job: rec.job,
      error: rec.error,
    });
  });

  app.post('/api/transcribe/url', async (req: Request, res: Response) => {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const refreshModeRaw = typeof req.body?.refreshMode === 'string' ? req.body.refreshMode : 'none';
    const refreshMode: 'none' | 'audio' | 'fresh' =
      refreshModeRaw === 'audio' || refreshModeRaw === 'fresh' ? refreshModeRaw : 'none';
    const existingDriveAudioFileId =
      typeof req.body?.driveAudioFileId === 'string' && isValidDriveFileId(req.body.driveAudioFileId)
        ? req.body.driveAudioFileId
        : undefined;
    const existingTitle = typeof req.body?.existingTitle === 'string' ? req.body.existingTitle.trim() : undefined;
    const existingAuthor = typeof req.body?.existingAuthor === 'string' ? req.body.existingAuthor.trim() : undefined;
    const existingThumbnailUrl =
      typeof req.body?.existingThumbnailUrl === 'string' ? req.body.existingThumbnailUrl.trim() : undefined;

    const classified = classifyUrl(rawUrl);

    if (!classified) {
      res.status(400).json({
        ok: false,
        code: 'INVALID_URL',
        message:
          'Enter a valid public YouTube, Facebook, Instagram, or direct audio/video URL (MP4, MP3, WAV, M4A, WebM).',
      });
      return;
    }

    const { parsedUrl, platform, youtubeId } = classified;
    const sourceKey = computeSourceKey({ platform, youtubeId, parsedUrl });
    const driveEnabled = isDriveBridgeConfigured() && isDriveRequestAuthorized(req);

    // Pre-flight Google Drive cache check (auto-open instantly on full transcript hit)
    let driveLookup: DriveLookupResult | null = null;
    if (driveEnabled && refreshMode !== 'fresh') {
      try {
        driveLookup = await lookupDriveCache(sourceKey);
        if (refreshMode === 'none' && driveLookup.hasTranscript && driveLookup.transcriptJob) {
          res.json({
            ok: true,
            job: driveLookup.transcriptJob,
            fromCache: true,
          });
          return;
        }
      } catch (lookupErr) {
        console.warn(
          'Pre-flight Drive lookup skipped:',
          lookupErr instanceof Error ? lookupErr.message : lookupErr
        );
      }
    }

    const cachedAudioId =
      refreshMode === 'fresh'
        ? undefined
        : driveLookup?.audioFile?.id || existingDriveAudioFileId;
    const cachedAudioMime = driveLookup?.audioFile?.mimeType;

    const record = createAsyncJob(
      cachedAudioId
        ? 'Loading cached audio from Google Drive...'
        : `Preparing ${platform} transcription pipeline...`
    );
    const updateProgress: ProgressUpdater = (stepIndex, stageLabel, progressPct) => {
      record.stepIndex = stepIndex;
      record.stageLabel = stageLabel;
      record.progressPct = progressPct;
    };

    res.status(202).json({
      ok: true,
      asyncJobId: record.asyncJobId,
      status: 'processing',
    });

    // Execute transcription asynchronously so long videos never hit proxy HTTP timeouts
    void (async () => {
      try {
        // Fast-path: Reuse Drive-cached audio (for partial cache hits OR "Re-transcribe cached audio")
        if (driveEnabled && cachedAudioId) {
          try {
            updateProgress(1, 'Pulling cached audio from Google Drive (skipping download)...', 22);
            const driveAudio = await downloadDriveAudioToTemp(cachedAudioId);
            const canonicalUrl =
              platform === 'youtube' && youtubeId
                ? `https://www.youtube.com/watch?v=${youtubeId}`
                : parsedUrl.toString();
            const oembed =
              platform === 'youtube' && youtubeId ? await fetchYouTubeMetadata(canonicalUrl) : {};
            const probedDuration = await probeAudioDuration(driveAudio.filePath);
            const fallbackTitle =
              existingTitle ||
              driveLookup?.transcriptJob?.title ||
              oembed.title ||
              `${platform === 'youtube' ? 'YouTube' : platform === 'facebook' ? 'Facebook' : platform === 'instagram' ? 'Instagram' : 'Media'} Transcript`;

            updateProgress(2, 'Re-transcribing cached Drive audio...', 38);
            const { payload: parsed, engineLabel } = await transcribeFileWithGroqPrimaryOrGeminiFallback({
              filePath: driveAudio.filePath,
              mimeType: cachedAudioMime || driveAudio.mimeType,
              contextHint: `Platform: ${platform}. Title: ${fallbackTitle}. Source: Cached Drive Audio`,
              durationHintSeconds: probedDuration,
              onProgress: updateProgress,
            });

            const normalized = normalizeTranscriptResult(
              {
                ...parsed,
                durationSeconds: probedDuration || parsed.durationSeconds,
              },
              {
                sourceType: platform,
                sourceUrl: canonicalUrl,
                mimeType: driveAudio.mimeType,
                embedVideoId: youtubeId,
                mediaKind: platform === 'youtube' && youtubeId ? 'youtube' : 'audio',
                remoteMediaUrl:
                  platform === 'youtube' && youtubeId ? undefined : `/api/drive/audio/${cachedAudioId}`,
                thumbnailUrl:
                  existingThumbnailUrl ||
                  driveLookup?.transcriptJob?.thumbnailUrl ||
                  oembed.thumbnailUrl ||
                  (youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` : undefined),
                fallbackTitle: fallbackTitle || parsed.title || 'Transcribed Recording',
                author: existingAuthor || driveLookup?.transcriptJob?.author || oembed.author,
                extractionMethod: `${engineLabel} via cached Google Drive audio`,
                sourceKey,
                driveAudioFileId: cachedAudioId,
                driveAudioMimeType: driveAudio.mimeType,
              }
            );

            record.job = await archiveJobToDriveIfEnabled({
              driveEnabled,
              sourceKey,
              job: normalized,
              existingDriveAudioFileId: cachedAudioId,
              existingDriveAudioMimeType: driveAudio.mimeType,
              onProgress: updateProgress,
            });
            record.status = 'completed';
            record.progressPct = 100;
            return;
          } catch (driveAudioErr) {
            if (refreshMode === 'audio') {
              throw driveAudioErr;
            }
            console.warn(
              'Cached Drive audio reuse failed; falling back to fresh extraction:',
              driveAudioErr instanceof Error ? driveAudioErr.message : driveAudioErr
            );
          }
        }

        // 1. YouTube: Tier 1 Groq Whisper -> Tier 2 Deepgram Nova-3 (via yt-dlp audio) -> Tier 3 Google Gemini fileUri fallback
        if (platform === 'youtube' && youtubeId) {
          const canonicalUrl = `https://www.youtube.com/watch?v=${youtubeId}`;
          updateProgress(1, 'Fetching YouTube video metadata...', 16);
          const oembed = await fetchYouTubeMetadata(canonicalUrl);
          const groq = getGroqClient();
          const deepgramKey = getDeepgramApiKey();

          if (groq || deepgramKey) {
            try {
              updateProgress(1, 'Extracting YouTube audio stream (yt-dlp)...', 24);
              const extractedYt = await extractSocialAudioWithYtDlp(canonicalUrl);
              const ytContext = `YouTube Video Title: ${oembed.title || extractedYt.title || 'Unknown'}`;
              let parsed: RawTranscriptPayload | null = null;
              let engineLabel = '';
              let ytGroqFailed = false;

              if (groq) {
                try {
                  parsed = await transcribeAudioFileWithGroq(
                    groq,
                    extractedYt.audioPath,
                    extractedYt.mimeType,
                    ytContext,
                    extractedYt.durationSeconds,
                    updateProgress
                  );
                  engineLabel = `Groq Whisper (${GROQ_WHISPER_MODEL})`;
                } catch (ytGroqErr) {
                  ytGroqFailed = true;
                  const safeReason =
                    ytGroqErr instanceof Error ? ytGroqErr.message.slice(0, 120) : 'groq failed';
                  console.warn(`YouTube Groq transcription failed: ${safeReason}`);
                  if (deepgramKey) {
                    updateProgress(2, 'Groq unavailable — switching to Deepgram Nova-3 fallback...', 38);
                  }
                }
              }

              if (!parsed && deepgramKey) {
                parsed = await transcribeAudioFileWithDeepgram(
                  deepgramKey,
                  extractedYt.audioPath,
                  extractedYt.mimeType,
                  ytContext,
                  extractedYt.durationSeconds,
                  updateProgress
                );
                engineLabel = ytGroqFailed
                  ? `Deepgram (${DEEPGRAM_MODEL}) fallback (after Groq error)`
                  : `Deepgram (${DEEPGRAM_MODEL})`;
              }

              if (parsed) {
                const normalized = normalizeTranscriptResult(
                  {
                    ...parsed,
                    durationSeconds: extractedYt.durationSeconds || parsed.durationSeconds,
                  },
                  {
                    sourceType: 'youtube',
                    sourceUrl: canonicalUrl,
                    embedVideoId: youtubeId,
                    mediaKind: 'youtube',
                    thumbnailUrl:
                      oembed.thumbnailUrl ||
                      extractedYt.thumbnailUrl ||
                      `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
                    fallbackTitle:
                      oembed.title || extractedYt.title || parsed.title || 'YouTube Video Transcript',
                    author: oembed.author || extractedYt.author,
                    extractionMethod: `${engineLabel} via yt-dlp native audio`,
                    sourceKey,
                  }
                );
                record.job = await archiveJobToDriveIfEnabled({
                  driveEnabled,
                  sourceKey,
                  job: normalized,
                  audioPath: extractedYt.audioPath,
                  audioMimeType: extractedYt.mimeType,
                  onProgress: updateProgress,
                });
                record.status = 'completed';
                record.progressPct = 100;
                return;
              }
            } catch (ytExtractOrEngineErr) {
              const safeReason =
                ytExtractOrEngineErr instanceof Error
                  ? ytExtractOrEngineErr.message.slice(0, 120)
                  : 'extraction failed';
              console.warn(`YouTube Groq/Deepgram path fell back to Gemini: ${safeReason}`);
              updateProgress(2, 'Switching to Google Gemini YouTube final fallback...', 42);
            }
          }

          const ai = getGeminiClient();
          updateProgress(2, 'Transcribing YouTube video via Google Gemini final fallback...', 52);
          const parsed = await generateStructuredTranscriptWithRetry(ai, [
            {
              fileData: {
                fileUri: canonicalUrl,
                mimeType: 'video/*',
              },
            },
            {
              text: `${TRANSCRIPTION_INSTRUCTIONS}\n\nYouTube Video Title: ${oembed.title || 'Unknown'}`,
            },
          ]);

          updateProgress(3, 'Building chapter timeline & exports...', 92);
          const normalized = normalizeTranscriptResult(parsed, {
            sourceType: 'youtube',
            sourceUrl: canonicalUrl,
            embedVideoId: youtubeId,
            mediaKind: 'youtube',
            thumbnailUrl: oembed.thumbnailUrl || `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
            fallbackTitle: oembed.title || parsed.title || 'YouTube Video Transcript',
            author: oembed.author,
            extractionMethod:
              groq || deepgramKey
                ? 'Google Gemini final fallback (Direct YouTube fileUri)'
                : 'Google Gemini final fallback (GROQ_API_KEY & DEEPGRAM_API_KEY not configured)',
            sourceKey,
          });
          record.job = await archiveJobToDriveIfEnabled({
            driveEnabled,
            sourceKey,
            job: normalized,
            onProgress: updateProgress,
          });
          record.status = 'completed';
          record.progressPct = 100;
          return;
        }

        // 2. Facebook & Instagram: yt-dlp + FFmpeg speech extraction -> Groq Whisper primary -> Gemini fallback
        if (platform === 'facebook' || platform === 'instagram') {
          const platformLabel = platform === 'facebook' ? 'Facebook' : 'Instagram';
          let ytdlpErrorReason = '';
          let extractedAudio: Awaited<ReturnType<typeof extractSocialAudioWithYtDlp>> | null = null;

          updateProgress(1, `Downloading ${platformLabel} audio stream (yt-dlp)...`, 18);
          try {
            extractedAudio = await extractSocialAudioWithYtDlp(parsedUrl.toString());
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg === 'FILE_TOO_LARGE') {
              record.status = 'failed';
              record.error = {
                ok: false,
                code: 'FILE_TOO_LARGE',
                platform,
                message: 'The extracted audio exceeded the 80 MB processing limit.',
                suggestedAction: 'Split the clip into shorter parts and upload via the Media Upload tab.',
              };
              return;
            }
            if (errMsg.startsWith('AUDIO_PROCESSING_ERROR:')) {
              record.status = 'failed';
              record.error = {
                ok: false,
                code: 'SERVER_ERROR',
                platform,
                message: 'Audio extraction succeeded, but server-side audio processing timed out.',
                technicalReason: errMsg.replace('AUDIO_PROCESSING_ERROR:', '').trim().slice(0, 260),
                suggestedAction: 'Please retry once, or upload a compressed MP3/M4A file directly.',
              };
              return;
            }
            const stderr = (err as { stderr?: string })?.stderr?.trim();
            ytdlpErrorReason = (stderr || errMsg).split('\n').slice(-2).join(' ').slice(0, 260);
          }

          if (extractedAudio) {
            const durMin = extractedAudio.durationSeconds
              ? `${Math.max(1, Math.round(extractedAudio.durationSeconds / 60))} min `
              : '';
            const fmtLabel = extractedAudio.mimeType === 'audio/mp4' ? 'native M4A' : 'audio';
            updateProgress(
              2,
              `Audio ready (${durMin}${fmtLabel}). Starting transcription...`,
              32
            );
            const { payload: parsed, engineLabel } = await transcribeFileWithGroqPrimaryOrGeminiFallback({
              filePath: extractedAudio.audioPath,
              mimeType: extractedAudio.mimeType,
              contextHint: `Platform: ${platformLabel}. Title: ${extractedAudio.title || 'Public social video'}. Creator: ${extractedAudio.author || 'Unknown'}`,
              durationHintSeconds: extractedAudio.durationSeconds,
              onProgress: updateProgress,
            });

            const normalized = normalizeTranscriptResult(
              {
                ...parsed,
                durationSeconds: extractedAudio.durationSeconds || parsed.durationSeconds,
              },
              {
                sourceType: platform,
                sourceUrl: parsedUrl.toString(),
                mimeType: extractedAudio.mimeType,
                mediaKind: 'audio',
                remoteMediaUrl: `/api/media/${extractedAudio.mediaId}`,
                thumbnailUrl: extractedAudio.thumbnailUrl,
                fallbackTitle:
                  extractedAudio.title || parsed.title || `${platformLabel} Video Transcript`,
                author: extractedAudio.author,
                extractionMethod: `${engineLabel} via yt-dlp native audio`,
                sourceKey,
              }
            );
            record.job = await archiveJobToDriveIfEnabled({
              driveEnabled,
              sourceKey,
              job: normalized,
              audioPath: extractedAudio.audioPath,
              audioMimeType: extractedAudio.mimeType,
              onProgress: updateProgress,
            });
            record.status = 'completed';
            record.progressPct = 100;
            return;
          }

          // Secondary fallback: OpenGraph public HTML extraction
          updateProgress(1, `Checking public ${platformLabel} OpenGraph stream...`, 24);
          const extracted = await tryExtractPublicSocialMedia(parsedUrl, platform);
          if (!extracted.mediaUrl) {
            record.status = 'failed';
            record.error = {
              ok: false,
              code: 'LOGIN_WALL_FALLBACK',
              platform,
              title: extracted.title,
              message: `${platformLabel} blocked automated server extraction for this link.`,
              technicalReason: ytdlpErrorReason || extracted.reason,
              suggestedAction:
                'Upload the downloaded video or audio clip below to transcribe it immediately with timestamps, or inspect the Platforms tab to see how production workers use residential proxies and session cookies.',
            };
            return;
          }

          updateProgress(2, `Downloading ${platformLabel} stream & transcribing...`, 46);
          const { buffer, mimeType } = await downloadMediaBuffer(extracted.mediaUrl);
          const { payload: parsed, engineLabel } = await transcribeBufferWithGroqPrimaryOrGeminiFallback({
            buffer,
            mimeType,
            contextHint: `Platform: ${platform}. Title: ${extracted.title || 'Public social video'}`,
            onProgress: updateProgress,
          });

          const normalized = normalizeTranscriptResult(parsed, {
            sourceType: platform,
            sourceUrl: parsedUrl.toString(),
            mimeType,
            mediaKind: mimeType.startsWith('audio/') ? 'audio' : 'video',
            remoteMediaUrl: extracted.mediaUrl,
            thumbnailUrl: extracted.thumbnailUrl,
            fallbackTitle: extracted.title || parsed.title || `${platformLabel} Video Transcript`,
            extractionMethod: `${engineLabel} via public ${platform} OpenGraph stream`,
            sourceKey,
          });
          record.job = await archiveJobToDriveIfEnabled({
            driveEnabled,
            sourceKey,
            job: normalized,
            audioBuffer: buffer,
            audioMimeType: mimeType,
            onProgress: updateProgress,
          });
          record.status = 'completed';
          record.progressPct = 100;
          return;
        }

        // 3. Direct media URL (.mp4, .mp3, .wav, .m4a, .webm)
        updateProgress(1, 'Fetching remote media stream...', 24);
        const { buffer, mimeType } = await downloadMediaBuffer(parsedUrl.toString());
        const urlFilename = path.basename(parsedUrl.pathname) || 'Direct Media';
        updateProgress(2, 'Transcribing media audio...', 46);
        const { payload: parsed, engineLabel } = await transcribeBufferWithGroqPrimaryOrGeminiFallback({
          buffer,
          mimeType,
          contextHint: `Direct media URL: ${urlFilename}`,
          onProgress: updateProgress,
        });

        const normalized = normalizeTranscriptResult(parsed, {
          sourceType: 'direct_url',
          sourceUrl: parsedUrl.toString(),
          fileName: urlFilename,
          mimeType,
          mediaKind: mimeType.startsWith('audio/') ? 'audio' : 'video',
          remoteMediaUrl: parsedUrl.toString(),
          fallbackTitle: parsed.title || urlFilename,
          extractionMethod: `${engineLabel} via direct media stream`,
          sourceKey,
        });
        record.job = await archiveJobToDriveIfEnabled({
          driveEnabled,
          sourceKey,
          job: normalized,
          audioBuffer: buffer,
          audioMimeType: mimeType,
          onProgress: updateProgress,
        });
        record.status = 'completed';
        record.progressPct = 100;
      } catch (err) {
        const mapped = formatGeminiError(err);
        record.status = 'failed';
        record.error = {
          ok: false,
          code: 'GEMINI_ERROR',
          platform,
          message: mapped.message,
          suggestedAction:
            platform === 'youtube'
              ? 'Confirm the YouTube video is Public (not Private or age-restricted), or upload the media file directly.'
              : 'Please retry in a moment or upload the media clip directly.',
        };
      }
    })();
  });

  app.post('/api/transcribe/upload', (req: Request, res: Response) => {
    upload.single('media')(req, res, (multerErr: unknown) => {
      if (multerErr) {
        const msg =
          multerErr instanceof multer.MulterError && multerErr.code === 'LIMIT_FILE_SIZE'
            ? 'File exceeds the 25 MB upload limit. Compress to MP3/M4A audio (e.g. 64 kbps mono) and retry.'
            : 'Could not read uploaded file.';
        res.status(400).json({
          ok: false,
          code: 'FILE_TOO_LARGE',
          message: msg,
        });
        return;
      }

      const file = req.file;
      if (!file) {
        res.status(400).json({
          ok: false,
          code: 'UNSUPPORTED_MEDIA',
          message: 'Attach a video or audio file (MP4, MOV, WebM, MP3, WAV, M4A).',
        });
        return;
      }

      const mimeType = inferMimeType(file.mimetype || '', file.originalname || '');
      if (!mimeType) {
        res.status(400).json({
          ok: false,
          code: 'UNSUPPORTED_MEDIA',
          message: `Unsupported file type (${file.mimetype || file.originalname}). Use MP4, MOV, WebM, MP3, WAV, or M4A.`,
        });
        return;
      }

      const sourceUrl =
        typeof req.body?.sourceUrl === 'string' && req.body.sourceUrl.trim()
          ? req.body.sourceUrl.trim()
          : undefined;
      const rawPlatform =
        typeof req.body?.sourcePlatform === 'string' ? req.body.sourcePlatform : 'file_upload';
      const sourceType: Platform =
        rawPlatform === 'facebook' || rawPlatform === 'instagram' || rawPlatform === 'youtube'
          ? rawPlatform
          : 'file_upload';

      const record = createAsyncJob(`Processing uploaded file ${file.originalname}...`);
      record.stepIndex = 1;
      record.progressPct = 22;

      res.status(202).json({
        ok: true,
        asyncJobId: record.asyncJobId,
        status: 'processing',
      });

      const updateUploadProgress: ProgressUpdater = (stepIndex, stageLabel, progressPct) => {
        record.stepIndex = stepIndex;
        record.stageLabel = stageLabel;
        record.progressPct = progressPct;
      };

      void (async () => {
        try {
          updateUploadProgress(2, 'Transcribing uploaded media...', 42);

          const { payload: parsed, engineLabel } =
            await transcribeBufferWithGroqPrimaryOrGeminiFallback({
              buffer: file.buffer,
              mimeType,
              contextHint: `Uploaded file: ${file.originalname}${sourceUrl ? ` (Source link: ${sourceUrl})` : ''}`,
              onProgress: updateUploadProgress,
            });

          updateUploadProgress(3, 'Building chapter timeline & exports...', 94);

          const cleanName = file.originalname
            .replace(/\.[^.]+$/, '')
            .replace(/[_-]+/g, ' ')
            .trim();

          const classifiedUploadUrl = sourceUrl ? classifyUrl(sourceUrl) : null;
          const uploadSourceKey = classifiedUploadUrl
            ? computeSourceKey({
                platform: classifiedUploadUrl.platform,
                youtubeId: classifiedUploadUrl.youtubeId,
                parsedUrl: classifiedUploadUrl.parsedUrl,
              })
            : computeSourceKey({ platform: 'file_upload', fileBuffer: file.buffer });
          const driveEnabled = isDriveBridgeConfigured() && isDriveRequestAuthorized(req);

          const normalized = normalizeTranscriptResult(parsed, {
            sourceType,
            sourceUrl,
            fileName: file.originalname,
            mimeType,
            mediaKind: mimeType.startsWith('audio/') ? 'audio' : 'video',
            fallbackTitle: parsed.title || cleanName || 'Uploaded Media Transcript',
            extractionMethod:
              sourceType === 'facebook' || sourceType === 'instagram'
                ? `${engineLabel} via media upload fallback (${sourceType})`
                : `${engineLabel} via direct file upload`,
            sourceKey: uploadSourceKey,
          });
          record.job = await archiveJobToDriveIfEnabled({
            driveEnabled,
            sourceKey: uploadSourceKey,
            job: normalized,
            audioBuffer: file.buffer,
            audioMimeType: mimeType,
            onProgress: updateUploadProgress,
          });
          record.status = 'completed';
          record.progressPct = 100;
        } catch (err) {
          const mapped = formatGeminiError(err);
          record.status = 'failed';
          record.error = {
            ok: false,
            code: 'GEMINI_ERROR',
            message: mapped.message,
          };
        }
      })();
    });
  });

  const ATF_ANALYSIS_PROMPT = `You are a financial transcript analyst. I am providing two inputs:
1. A timestamped video/livestream transcript (which may be in Hindi, Hinglish, or English with speech-to-text typos).
2. A reference image listing the "ATF Top 60 Stocks" with their serial numbers (#1–#60).

Your task is to cross-reference EVERY stock and ETF mentioned in the transcript against EVERY stock in the ATF Top 60 image and produce a strictly structured output.

### Step-by-Step Rules (Follow Strictly)

1. Read the Reference Image Completely:
- First extract all 60 numbered stocks from the ATF Top 60 image exactly as listed (preserve the image's serial numbers, including any duplicate or skipped numbering quirks).

2. Decode Speech-to-Text (ASR) Errors Carefully:
- Transcripts may contain phonetic Hindi/English typos for Indian or international stock/ETF names (e.g., "मन्नापूरम फनांस" = Manappuram Finance, "टीएमपीवी" = Tata Motors Passenger Vehicles, "एसडीएफसी" = HDFC Bank, "वोटर फोन / वीआई" = Vodafone Idea, "NSC" = NSE, "आये अरेफ से" = IRFC, "एनवीडिया" = NVIDIA, "क्यूक्यूक्यू" = QQQ, "गोल्ड बीज़" = Gold BeES).
- Normalize clear phonetic matches to the official company or ETF name.
- If a stock or ETF name is garbled and cannot be identified with certainty, keep it verbatim and append *(as transcribed)*. Never guess or invent a company or ETF name.

3. Table 1 Criteria (IN ATF Top 60 — Strict "Strong Buy" Only):
- Include an ATF Top 60 stock in Table 1 ONLY if the speaker gives an emphatic bullish call, such as:
  - "बहुत अच्छा है" / "बहुत बहुत अच्छा है" (very good)
  - "भर-भर के खरीदो" / "खूब खरीदो" / "लगातार खरीदो" (buy heavily / continuously)
  - "हर फ्राइडे खरीदो" (buy every Friday / 26 months)
  - Explicit "a steal", "#1 stock", or strong multi-bagger / 2x–3x / specific upside target call (including high-conviction swing trades).
- Do NOT include in Table 1:
  - ATF 60 stocks only called plain "अच्छा है" / "ठीक है" (mild buy/good) without strong conviction or buying frequency.
  - ATF 60 stocks marked "too expensive / wait", "hold only", "book profit / exit", "avoid", or "sell".
  - ATF 60 stocks mentioned only in passing as sector/FII allocation examples with no direct buy recommendation.
  - Report all such non-Strong-Buy ATF 60 mentions in the *Note on other ATF 60 stocks discussed in the transcript* paragraph below Table 1.
- If zero ATF Top 60 stocks qualify as Strong Buy, output a single \`None\` row in Table 1.

4. Table 2 Criteria (OUTSIDE ATF Top 60 — ALL Discussed Stocks & ETFs):
- Unlike Table 1, Table 2 must include **EVERY** individual stock (Indian or international/US, e.g., NVIDIA, Apple, Microsoft) AND **EVERY** ETF, index fund, or tracked index/commodity ETF (e.g., S&P 500, QQQ, Nifty 50 / Nifty BeES, Nasdaq 100, Gold / Gold BeES, Silver ETF, sectoral ETFs) discussed anywhere in the transcript that is NOT in the ATF Top 60 image.
- Include them **even if the video is unrelated to ATF Top 60**, **even if the speaker did NOT give a strict "Strong Buy" call**, and **even if no price levels were stated** (including moderate buys, broad bullish/allocation views, swing trades, hold/wait, avoid/sell, valuation or accounting discussions, and passing mentions).
- Order rows in Table 2 with **Strong Buy / Bullish / Swing Trade** calls first, followed by other stances (**Mild Buy**, **Hold / Wait**, **Avoid / Sell**, **Discussed / Mentioned**).
- Fill the \`Stance\` column accurately for each row (e.g., \`Strong Buy\`, \`Bullish / Accumulate\`, \`Swing Trade\`, \`Mild Buy\`, \`Hold / Wait\`, \`Avoid / Sell\`, \`Discussed / Mentioned\`).
- Output \`None\` in Table 2 **ONLY** if the video/transcript is completely unrelated to stocks, ETFs, indices, or equity/commodity investing (i.e., zero stocks or ETFs outside ATF Top 60 are discussed at all).

5. Capture Exact Levels, Targets, Timestamps & Conflicts:
- List every timestamp where the stock or ETF is discussed (e.g., 04:06, 43:57).
- Extract exact entry prices, dip levels, exit/target prices, holding horizons, buying cadence (e.g., "all 4 Fridays/month", "1 Friday/month", "3-month swing trade"), and concise key speaker commentary (e.g., macro allocation, valuation, or risk notes).
- If no price level is mentioned, explicitly write \`No price level given\` alongside the speaker's actual commentary.
- If the speaker gives different targets at different timestamps, report both with their timestamps—do not pick one.
- Do not add external market prices, live quotes, or your own financial advice.

6. Mandatory Count Verification (Do Silently Before Outputting):
- Verify that: (ATF 60 stocks discussed in transcript—whether Strong Buy or not) + (ATF 60 stocks NOT discussed in transcript) = Total stocks in the ATF Top 60 image.
- Do not miss any stock from the image.

### Required Output Format (Follow Exactly)

Output ONLY the following 3 sections in exact Markdown table format:

### 1. Strong Buy Stocks — IN ATF Top 60

| ATF # | Stock | Timestamp | Levels, Targets & Buying Guidance |
| :--- | :--- | :--- | :--- |
| [Number from image] | [Company Name] | [MM:SS] | [Exact entry/target levels, horizon, buying frequency, and key speaker notes] |

*Note on other ATF 60 stocks discussed in the transcript (not called "strong buy"):* [One concise paragraph listing every other ATF 60 stock mentioned in the transcript with its ATF # and the speaker's actual stance—especially flagging any stock on the ATF 60 list that the speaker called "wait", "avoid", or "sell", or only mentioned in passing. If none of the ATF Top 60 stocks were discussed, state that clearly.]

### 2. Stocks & ETFs Discussed — OUTSIDE ATF Top 60

| Stock / ETF | Stance | Timestamp | Levels, Targets & Buying Guidance |
| :--- | :--- | :--- | :--- |
| [Company or ETF Name] | [Strong Buy / Bullish / Swing Trade / Mild Buy / Hold / Wait / Avoid / Sell / Discussed] | [MM:SS] | [Exact entry/target levels, horizon, buying frequency, and key speaker notes; write "No price level given" if none stated] |

### 3. Stocks in ATF Top 60 — NOT Discussed in the Transcript ([Count] Stocks)

| ATF # | Company | ATF # | Company |
| :--- | :--- | :--- | :--- |
| [Number] | [Company Name] | [Number] | [Company Name] |`;

  const ALLOWED_ATF_REF_FILES: Array<{ fileName: string; mimeType: string }> = [
    { fileName: 'ATF60Stocks.jpg', mimeType: 'image/jpeg' },
    { fileName: 'ATF60Stocks.jpeg', mimeType: 'image/jpeg' },
    { fileName: 'ATF60Stocks.png', mimeType: 'image/png' },
  ];

  function resolveAtfReferenceImage(): {
    filePath: string;
    fileName: string;
    mimeType: string;
    publicUrl: string;
  } | null {
    const searchDirs = Array.from(
      new Set([
        path.resolve(__dirname, 'public'),
        path.resolve(__dirname, 'dist'),
        path.resolve(process.cwd(), 'public'),
        path.resolve(process.cwd(), 'dist'),
      ])
    );
    for (const dir of searchDirs) {
      for (const candidate of ALLOWED_ATF_REF_FILES) {
        const fullPath = path.resolve(dir, candidate.fileName);
        if (fullPath.startsWith(dir + path.sep) && existsSync(fullPath)) {
          return {
            filePath: fullPath,
            fileName: candidate.fileName,
            mimeType: candidate.mimeType,
            publicUrl: '/api/analysis/reference/image',
          };
        }
      }
    }
    return null;
  }

  function detectImageMimeFromMagicBytes(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
    if (buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    ) {
      return 'image/png';
    }
    if (
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp';
    }
    return null;
  }

  function isProgressiveJpeg(buf: Buffer): boolean {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return false;
    let offset = 2;
    while (offset + 3 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < buf.length && buf[offset] === 0xff) offset += 1;
      if (offset >= buf.length) break;
      const marker = buf[offset];
      offset += 1;
      if (marker === 0xc2) return true; // SOF2 progressive DCT
      if (marker === 0xc0) return false; // SOF0 baseline DCT
      if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
      if (marker >= 0xd0 && marker <= 0xd8) continue;
      if (offset + 1 >= buf.length) break;
      const segLen = (buf[offset] << 8) | buf[offset + 1];
      if (segLen < 2) break;
      offset += segLen;
    }
    return false;
  }

  async function normalizeReferenceImageForVision(
    buf: Buffer
  ): Promise<{ buffer: Buffer; mimeType: 'image/jpeg' | 'image/png' }> {
    const MAX_GROQ_IMAGE_BYTES = 2_800_000; // Keep base64 payload comfortably under Groq's 4 MB limit
    const detected = detectImageMimeFromMagicBytes(buf);

    if (
      detected === 'image/jpeg' &&
      buf.byteLength <= MAX_GROQ_IMAGE_BYTES &&
      !isProgressiveJpeg(buf)
    ) {
      return { buffer: buf, mimeType: 'image/jpeg' };
    }
    if (detected === 'image/png' && buf.byteLength <= MAX_GROQ_IMAGE_BYTES) {
      return { buffer: buf, mimeType: 'image/png' };
    }

    const workDir = path.join(os.tmpdir(), `cuescript_img_${crypto.randomBytes(6).toString('hex')}`);
    await fs.mkdir(workDir, { recursive: true });
    const inExt = detected === 'image/png' ? '.png' : detected === 'image/webp' ? '.webp' : '.jpg';
    const inPath = path.join(workDir, `input${inExt}`);
    const outPath = path.join(workDir, 'normalized.jpg');

    try {
      await fs.writeFile(inPath, buf);
      await execFileAsync(
        FFMPEG_BIN,
        [
          '-y',
          '-i',
          inPath,
          '-frames:v',
          '1',
          '-vf',
          "scale='min(1600,iw)':-2",
          '-pix_fmt',
          'yuvj420p',
          '-q:v',
          '3',
          outPath,
        ],
        { timeout: 15_000 }
      );
      const outBuf = await fs.readFile(outPath);
      if (detectImageMimeFromMagicBytes(outBuf) !== 'image/jpeg') {
        throw new Error('Reference image could not be encoded as a valid baseline JPEG.');
      }
      return { buffer: outBuf, mimeType: 'image/jpeg' };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  function stripReasoningTags(raw: string): string {
    return raw
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^<think>[\s\S]*$/i, '')
      .trim();
  }

  async function runAnalysisWithOpenAiCompatPrimary(
    refImageBuffer: Buffer,
    refImageMimeType: string,
    transcriptText: string
  ): Promise<string> {
    const normalized = await normalizeReferenceImageForVision(refImageBuffer);
    const effectiveMime = normalized.mimeType || refImageMimeType;
    const dataUrl = `data:${effectiveMime};base64,${normalized.buffer.toString('base64')}`;

    const endpoint = `${OPENAI_COMPAT_ANALYSIS_BASE_URL}/chat/completions`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_COMPAT_ANALYSIS_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `${ATF_ANALYSIS_PROMPT}\n\n---\n\n### TRANSCRIPT:\n${transcriptText}`,
              },
              {
                type: 'image_url',
                image_url: { url: dataUrl },
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });

    const rawBody = await response.text();
    if (!response.ok) {
      const compactErr = rawBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
      throw new Error(`HTTP ${response.status} ${response.statusText}${compactErr ? `: ${compactErr}` : ''}`);
    }

    let parsed: {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> | null } }>;
    };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new Error('OpenAI-compatible endpoint returned non-JSON response.');
    }

    const msgContent = parsed.choices?.[0]?.message?.content;
    const textContent =
      typeof msgContent === 'string'
        ? msgContent
        : Array.isArray(msgContent)
          ? msgContent.map((part) => part?.text || '').join('\n')
          : '';

    const cleaned = stripReasoningTags(textContent);
    if (!cleaned) {
      throw new Error('OpenAI-compatible endpoint returned an empty response.');
    }
    return cleaned;
  }

  async function runAnalysisWithGeminiFallback(
    ai: GoogleGenAI,
    refImageBuffer: Buffer,
    refImageMimeType: string,
    refImageName: string,
    transcriptBuffer: Buffer
  ): Promise<string> {
    const workDir = path.join(os.tmpdir(), `cuescript_analysis_${crypto.randomBytes(6).toString('hex')}`);
    await fs.mkdir(workDir, { recursive: true });

    const refExt = refImageMimeType === 'image/png' ? '.png' : '.jpg';
    const tempImagePath = path.join(workDir, `ATF60Stocks${refExt}`);
    const tempTxtPath = path.join(workDir, 'transcript.txt');
    const uploadedNames: string[] = [];

    try {
      await fs.writeFile(tempImagePath, refImageBuffer);
      await fs.writeFile(tempTxtPath, transcriptBuffer);

      const uploadedImage = await ai.files.upload({
        file: tempImagePath,
        config: { mimeType: refImageMimeType, displayName: refImageName },
      });
      if (uploadedImage.name) uploadedNames.push(uploadedImage.name);

      const uploadedTxt = await ai.files.upload({
        file: tempTxtPath,
        config: { mimeType: 'text/plain', displayName: 'transcript.txt' },
      });
      if (uploadedTxt.name) uploadedNames.push(uploadedTxt.name);

      if (!uploadedImage.uri || !uploadedTxt.uri) {
        throw new Error('Gemini Files API upload did not return file URIs.');
      }

      const parts = [
        {
          fileData: {
            fileUri: uploadedImage.uri,
            mimeType: uploadedImage.mimeType || refImageMimeType,
          },
        },
        {
          fileData: {
            fileUri: uploadedTxt.uri,
            mimeType: uploadedTxt.mimeType || 'text/plain',
          },
        },
        { text: ATF_ANALYSIS_PROMPT },
      ];

      const attempts = [
        { model: GEMINI_MODEL, delayMs: 0 },
        { model: GEMINI_FALLBACK_MODEL, delayMs: 1200 },
        { model: GEMINI_FALLBACK_MODEL, delayMs: 5000 },
      ];

      let lastErr: unknown;
      for (const attempt of attempts) {
        if (attempt.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, attempt.delayMs));
        }
        try {
          const response = await ai.models.generateContent({
            model: attempt.model,
            contents: [{ role: 'user', parts }],
          });
          const text = (response.text || '').trim();
          if (!text) {
            throw new Error('Gemini analysis returned an empty response.');
          }
          return text;
        } catch (err) {
          lastErr = err;
          if (!isTransientGeminiError(err)) {
            throw err;
          }
        }
      }
      throw lastErr;
    } finally {
      for (const name of uploadedNames) {
        await ai.files.delete({ name }).catch(() => {});
      }
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  interface AnalysisJobRecord {
    analysisJobId: string;
    status: 'processing' | 'completed' | 'failed';
    stageLabel: string;
    createdAt: number;
    analysis?: {
      markdown: string;
      engineUsed: string;
      generatedAt: string;
      referenceImageName: string;
    };
    error?: string;
  }

  const analysisJobs = new Map<string, AnalysisJobRecord>();
  const analysisUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
  });

  app.get('/api/analysis/reference', (_req: Request, res: Response) => {
    const ref = resolveAtfReferenceImage();
    if (!ref) {
      res.json({ ok: true, available: false });
      return;
    }
    res.json({
      ok: true,
      available: true,
      fileName: ref.fileName,
      publicUrl: ref.publicUrl,
    });
  });

  app.get('/api/analysis/reference/image', (_req: Request, res: Response) => {
    const ref = resolveAtfReferenceImage();
    if (!ref) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', ref.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=300');
    createReadStream(ref.filePath).pipe(res);
  });

  app.get('/api/analyze/jobs/:jobId', (req: Request, res: Response) => {
    const jobId = req.params.jobId || '';
    if (!/^ana_[a-f0-9]+$/i.test(jobId)) {
      res.status(400).json({ ok: false, message: 'Invalid analysis job identifier.' });
      return;
    }
    const rec = analysisJobs.get(jobId);
    if (!rec) {
      res.status(404).json({ ok: false, message: 'Analysis job not found or expired.' });
      return;
    }
    res.json({
      ok: true,
      analysisJobId: rec.analysisJobId,
      status: rec.status,
      stageLabel: rec.stageLabel,
      analysis: rec.analysis,
      error: rec.error,
    });
  });

  app.post('/api/analyze', (req: Request, res: Response) => {
    analysisUpload.fields([
      { name: 'transcript', maxCount: 1 },
      { name: 'referenceImage', maxCount: 1 },
    ])(req, res, async (multerErr: unknown) => {
      if (multerErr) {
        res.status(400).json({ ok: false, message: 'Could not read uploaded transcript or image attachment.' });
        return;
      }

      const files = (req.files || {}) as Record<string, Express.Multer.File[]>;
      const transcriptFile = files.transcript?.[0];
      if (!transcriptFile || transcriptFile.buffer.byteLength === 0) {
        res.status(400).json({ ok: false, message: 'Missing generated .txt transcript file attachment.' });
        return;
      }

      let refBuffer: Buffer;
      let refMimeType: string;
      let refFileName: string;

      const diskRef = resolveAtfReferenceImage();
      if (diskRef) {
        refBuffer = await fs.readFile(diskRef.filePath);
        refMimeType = diskRef.mimeType;
        refFileName = diskRef.fileName;
      } else {
        const uploadedRef = files.referenceImage?.[0];
        if (!uploadedRef || uploadedRef.buffer.byteLength === 0) {
          res.status(400).json({
            ok: false,
            message:
              'Reference image ATF60Stocks.jpg was not found in /public. Place ATF60Stocks.jpg in /public or attach it in the Gen AI Analysis panel.',
          });
          return;
        }
        const mime = (uploadedRef.mimetype || '').toLowerCase();
        if (mime !== 'image/jpeg' && mime !== 'image/jpg' && mime !== 'image/png') {
          res.status(400).json({ ok: false, message: 'Reference image must be a JPG or PNG file.' });
          return;
        }
        refBuffer = uploadedRef.buffer;
        refMimeType = mime === 'image/png' ? 'image/png' : 'image/jpeg';
        refFileName = 'ATF60Stocks.jpg';
      }

      const now = Date.now();
      for (const [id, item] of analysisJobs.entries()) {
        if (now - item.createdAt > 30 * 60 * 1000) analysisJobs.delete(id);
      }

      const analysisJobId = `ana_${crypto.randomBytes(8).toString('hex')}`;
      const record: AnalysisJobRecord = {
        analysisJobId,
        status: 'processing',
        stageLabel: `Running Gen AI Analysis with OpenAI (${OPENAI_COMPAT_ANALYSIS_MODEL})...`,
        createdAt: now,
      };
      analysisJobs.set(analysisJobId, record);

      res.status(202).json({
        ok: true,
        analysisJobId,
        status: 'processing',
      });

      const transcriptBuffer = transcriptFile.buffer;
      const transcriptText = transcriptBuffer.toString('utf-8');

      void (async () => {
        try {
          try {
            record.stageLabel = `Running Gen AI Analysis with OpenAI (${OPENAI_COMPAT_ANALYSIS_MODEL})...`;
            const markdown = await runAnalysisWithOpenAiCompatPrimary(
              refBuffer,
              refMimeType,
              transcriptText
            );
            record.analysis = {
              markdown,
              engineUsed: `OpenAI (${OPENAI_COMPAT_ANALYSIS_MODEL})`,
              generatedAt: new Date().toISOString(),
              referenceImageName: refFileName,
            };
            record.status = 'completed';
            record.stageLabel = 'Analysis complete';
            return;
          } catch (primaryErr) {
            const safeReason = primaryErr instanceof Error ? primaryErr.message.slice(0, 140) : 'primary endpoint failed';
            console.warn(`OpenAI Gen AI Analysis failed (${safeReason}); falling back to Google Gemini.`);
            record.stageLabel = 'Primary API unavailable — falling back to Google Gemini...';
          }

          const ai = getGeminiClient();
          const markdown = await runAnalysisWithGeminiFallback(
            ai,
            refBuffer,
            refMimeType,
            refFileName,
            transcriptBuffer
          );
          record.analysis = {
            markdown,
            engineUsed: 'Google Gemini fallback',
            generatedAt: new Date().toISOString(),
            referenceImageName: refFileName,
          };
          record.status = 'completed';
          record.stageLabel = 'Analysis complete';
        } catch (err) {
          const mapped = formatGeminiError(err);
          record.status = 'failed';
          record.error = mapped.message;
        }
      })();
    });
  });

  // ============================================================================
  // Phase 2: Consolidated Stock Recommendations (from per-video analysis.md files)
  // ============================================================================

  const RECOMMENDATIONS_RESPONSE_SCHEMA = {
    type: Type.OBJECT,
    properties: {
      executiveSummary: {
        type: Type.STRING,
        description:
          '2 to 3 concise sentences summarizing the strongest overlapping picks, notable swing setups, and any cross-video cautions found across the provided analysis.md files.',
      },
      strongBuys: {
        type: Type.ARRAY,
        description:
          'Consolidated list of high-conviction Strong Buy / long-term accumulation / core portfolio stocks (one entry per stock across all files).',
        items: {
          type: Type.OBJECT,
          properties: {
            stock: { type: Type.STRING, description: 'Official normalized company name.' },
            atfNumber: {
              type: Type.STRING,
              nullable: true,
              description: 'ATF Top 60 serial number such as "#12", or null if outside ATF Top 60.',
            },
            entryAndDipLevels: {
              type: Type.STRING,
              description:
                'Exact entry zones, CMP/buy levels, or dip prices mentioned across sources, or "No price level given".',
            },
            targetsAndStopLoss: {
              type: Type.STRING,
              description:
                'Exact upside targets, multi-bagger expectations, exit levels, or stop-loss mentioned across sources, or "No target given". If different videos give different targets, report all with source IDs.',
            },
            horizonAndGuidance: {
              type: Type.STRING,
              description:
                'Holding horizon, buying cadence (e.g., Friday SIP, accumulate on dips), and concise conviction notes grounded strictly in the files.',
            },
            hasLevelConflict: {
              type: Type.BOOLEAN,
              description:
                'True only if multiple source files state differing or conflicting entry levels, targets, or stances for this stock.',
            },
            sources: {
              type: Type.ARRAY,
              description: 'Compact source IDs and timestamps where this stock and its levels came from.',
              items: {
                type: Type.OBJECT,
                properties: {
                  sourceId: {
                    type: Type.STRING,
                    description: 'Exact short source ID from the header (e.g., "S1", "S2", "S3").',
                  },
                  timestamps: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Exact MM:SS timestamps extracted from that analysis.md file.',
                  },
                  specificNotes: {
                    type: Type.STRING,
                    description: 'Short note showing which specific level or call came from this video.',
                  },
                },
                required: ['sourceId', 'timestamps'],
              },
            },
          },
          required: [
            'stock',
            'entryAndDipLevels',
            'targetsAndStopLoss',
            'horizonAndGuidance',
            'hasLevelConflict',
            'sources',
          ],
        },
      },
      swingTrades: {
        type: Type.ARRAY,
        description:
          'Consolidated list of short-to-medium-term Swing Trades / tactical positional setups (one entry per stock across all files).',
        items: {
          type: Type.OBJECT,
          properties: {
            stock: { type: Type.STRING, description: 'Official normalized company name.' },
            atfNumber: {
              type: Type.STRING,
              nullable: true,
              description: 'ATF Top 60 serial number such as "#12", or null if outside ATF Top 60.',
            },
            entryAndDipLevels: {
              type: Type.STRING,
              description:
                'Exact entry zones, breakout/dip buy levels mentioned across sources, or "No price level given".',
            },
            targetsAndStopLoss: {
              type: Type.STRING,
              description:
                'Exact swing exit targets, percentage upside, or stop-loss mentioned across sources, or "No target given".',
            },
            horizonAndGuidance: {
              type: Type.STRING,
              description:
                'Swing timeframe (e.g., 1-3 months, short-term tactical bounce), profit-booking rules, and key notes.',
            },
            hasLevelConflict: {
              type: Type.BOOLEAN,
              description:
                'True only if multiple source files state differing or conflicting swing targets or levels.',
            },
            sources: {
              type: Type.ARRAY,
              description: 'Compact source IDs and timestamps where this swing trade and its levels came from.',
              items: {
                type: Type.OBJECT,
                properties: {
                  sourceId: {
                    type: Type.STRING,
                    description: 'Exact short source ID from the header (e.g., "S1", "S2", "S3").',
                  },
                  timestamps: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Exact MM:SS timestamps extracted from that analysis.md file.',
                  },
                  specificNotes: {
                    type: Type.STRING,
                    description: 'Short note showing which specific swing level or target came from this video.',
                  },
                },
                required: ['sourceId', 'timestamps'],
              },
            },
          },
          required: [
            'stock',
            'entryAndDipLevels',
            'targetsAndStopLoss',
            'horizonAndGuidance',
            'hasLevelConflict',
            'sources',
          ],
        },
      },
    },
    required: ['executiveSummary', 'strongBuys', 'swingTrades'],
  };

  const RECOMMENDATIONS_PROMPT = `You are a senior equity research consolidator. I am providing multiple per-video analysis.md files, each tagged with a short Source ID (S1, S2, S3, ...).

Your task is to synthesize ALL provided analysis.md files into two strictly structured, consolidated recommendation lists:
1. "strongBuys": High-conviction core/long-term Strong Buy calls (e.g., strong accumulation, Friday SIP / 26-month plan, multi-bagger / 2x-3x calls, emphatic "steal" or core ATF Top 60 / outside ATF strong buys).
2. "swingTrades": Tactical short-to-medium-term Swing Trades, positional trades, explicit "swing trade" / 1-6 month / bounce / profit-booking setups.

### Strict Consolidation Rules
1. Consolidate Per Stock:
   - If the same stock appears in multiple analysis.md files within the same category, merge it into ONE consolidated entry (normalize minor spelling/case differences to the official company name).
   - If a stock is explicitly recommended as BOTH a long-term Strong Buy AND a separate Swing Trade setup across the files, include it in both arrays with the respective levels/notes clearly scoped to each category.
2. Exclude Non-Buys:
   - Note that Section 2 ("OUTSIDE ATF Top 60") in analysis.md can list ALL discussed outside-ATF stocks & ETFs along with their Stance. ONLY promote an item from Section 2 into "strongBuys" or "swingTrades" if its stance is an actionable Strong Buy, Bullish/Accumulate, or Swing Trade recommendation.
   - Do NOT include stocks or ETFs whose stance across the files is strictly "avoid", "sell", "too expensive / wait", "hold only", or "discussed / mentioned in passing" without a buy recommendation.
   - If one video recommends a stock as a Strong Buy while another video warns "wait / expensive / book profit", keep the stock if strongly recommended, set "hasLevelConflict": true, and explicitly cite the caution under that source ID.
3. Preserve Exact Levels & Never Fabricate:
   - Extract exact entry prices, dip zones, targets, upside multiples, stop-losses, holding horizons, and buying cadences directly from the attached files.
   - If no entry/dip level was stated, write "No price level given". If no target/stop-loss was stated, write "No target given".
   - If different videos give different price targets or entry levels for the same stock, include ALL of them and set "hasLevelConflict": true.
   - NEVER add external live market prices, ticker guesses, or personal financial advice.
4. Compact Source Attribution (IMPORTANT):
   - Reference each source ONLY by its short "sourceId" ("S1", "S2", "S3", etc.) — do NOT repeat long video titles or filenames in JSON. The server expands each sourceId automatically.
   - Include exact "timestamps" (e.g., ["04:06", "43:57"]) and concise "specificNotes" attributing which levels/calls came from that source.
5. ATF Number Preservation:
   - Preserve the exact ATF Top 60 serial number (e.g., "#12") if present in any source file; otherwise set "atfNumber": null.
6. Output Format:
   - Return ONLY valid JSON (no markdown fences, no commentary outside JSON) matching this exact shape:
{
  "executiveSummary": "2-3 concise sentences summarizing overlapping high-conviction picks, notable swing setups, and cross-video conflicts.",
  "strongBuys": [
    {
      "stock": "Company Name",
      "atfNumber": "#12 or null",
      "entryAndDipLevels": "Exact entry/dip prices or No price level given",
      "targetsAndStopLoss": "Exact targets/exit/SL or No target given",
      "horizonAndGuidance": "Concise horizon, buying cadence, key conviction notes",
      "hasLevelConflict": false,
      "sources": [
        {
          "sourceId": "S1",
          "timestamps": ["04:06"],
          "specificNotes": "Exact levels or call from S1"
        }
      ]
    }
  ],
  "swingTrades": [
    {
      "stock": "Company Name",
      "atfNumber": "#12 or null",
      "entryAndDipLevels": "Exact entry/dip prices or No price level given",
      "targetsAndStopLoss": "Exact swing target/SL or No target given",
      "horizonAndGuidance": "Concise swing horizon and tactical setup notes",
      "hasLevelConflict": false,
      "sources": [
        {
          "sourceId": "S2",
          "timestamps": ["12:40"],
          "specificNotes": "Exact swing levels from S2"
        }
      ]
    }
  ]
}`;

  interface AttachedAnalysisFile {
    sourceId: string;
    fileName: string;
    videoTitle: string;
    folderName?: string;
    jobId?: string;
    sourceKey?: string;
    markdown: string;
    condensedMarkdown: string;
    buffer: Buffer;
  }

  interface RawRecommendationSourceItem {
    sourceId?: string;
    videoTitle?: string;
    sourceFileName?: string;
    timestamps?: string[];
    specificNotes?: string;
  }

  interface RawRecommendationEntry {
    stock?: string;
    atfNumber?: string | number | null;
    entryAndDipLevels?: string;
    targetsAndStopLoss?: string;
    horizonAndGuidance?: string;
    hasLevelConflict?: boolean;
    sources?: RawRecommendationSourceItem[];
  }

  interface RawRecommendationJson {
    executiveSummary?: string;
    strongBuys?: RawRecommendationEntry[];
    swingTrades?: RawRecommendationEntry[];
  }

  function sanitizeRecommendationVideoTitle(
    folderName: string | undefined,
    rawTitle: string | undefined,
    fallbackFileName: string
  ): string {
    const preferred = (folderName || '').replace(/\s+/g, ' ').trim();
    if (preferred) {
      return preferred.length > 72 ? `${preferred.slice(0, 72).trimEnd()}…` : preferred;
    }
    const cleaned = (rawTitle || fallbackFileName.replace(/\.md$/i, ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return 'Analyzed Video';
    return cleaned.length > 64 ? `${cleaned.slice(0, 64).trimEnd()}…` : cleaned;
  }

  function stripNotDiscussedSection(markdown: string): string {
    const normalized = markdown.replace(/\r\n/g, '\n').trim();
    // Strip "### 3. Stocks in ATF Top 60 — NOT Discussed..." table to eliminate irrelevant token noise
    const match = normalized.match(/\n#{2,4}\s*3\.\s*[^\n]*not\s+discussed[\s\S]*$/i);
    if (match && typeof match.index === 'number' && match.index > 100) {
      return normalized.slice(0, match.index).trim();
    }
    return normalized;
  }

  function parseLooseJsonObject<T>(rawText: string): T {
    const stripped = stripReasoningTags(rawText);
    const fencedMatch = stripped.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fencedMatch?.[1] || stripped).trim();
    try {
      return JSON.parse(candidate) as T;
    } catch {
      const firstBrace = candidate.indexOf('{');
      const lastBrace = candidate.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        return JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as T;
      }
      throw new Error('Model did not return valid JSON for stock recommendations.');
    }
  }

  function normalizeAtfNumber(raw: string | number | null | undefined): string | null {
    if (raw === null || raw === undefined) return null;
    const str = String(raw).trim();
    if (!str || /^(null|none|n\/a|outside|—|-)$/i.test(str)) return null;
    if (/^\d+$/.test(str)) return `#${str}`;
    return str;
  }

  function resolveAttachedSource(
    raw: RawRecommendationSourceItem,
    attachedFiles: AttachedAnalysisFile[]
  ): AttachedAnalysisFile | undefined {
    const rawId = typeof raw?.sourceId === 'string' ? raw.sourceId.trim().toUpperCase() : '';
    if (rawId) {
      const byExactId = attachedFiles.find((f) => f.sourceId === rawId);
      if (byExactId) return byExactId;
      const numMatch = rawId.match(/(\d+)/);
      if (numMatch) {
        const idx = Number(numMatch[1]) - 1;
        if (idx >= 0 && idx < attachedFiles.length) return attachedFiles[idx];
      }
    }
    const rawFile = typeof raw?.sourceFileName === 'string' ? raw.sourceFileName.trim().toLowerCase() : '';
    if (rawFile) {
      const byFile = attachedFiles.find((f) => f.fileName.toLowerCase() === rawFile);
      if (byFile) return byFile;
    }
    const rawTitle = typeof raw?.videoTitle === 'string' ? raw.videoTitle.trim().toLowerCase() : '';
    if (rawTitle) {
      const byTitle = attachedFiles.find(
        (f) =>
          f.videoTitle.toLowerCase() === rawTitle ||
          (f.folderName && f.folderName.toLowerCase() === rawTitle)
      );
      if (byTitle) return byTitle;
    }
    return undefined;
  }

  function normalizeRecommendationEntries(
    items: RawRecommendationEntry[] | undefined,
    category: 'strong_buy' | 'swing_trade',
    attachedFiles: AttachedAnalysisFile[]
  ): RecommendationEntryPayload[] {
    if (!Array.isArray(items)) return [];
    const fallbackSource = attachedFiles[0];
    const result: RecommendationEntryPayload[] = [];

    for (const item of items) {
      const stock = typeof item?.stock === 'string' ? item.stock.trim() : '';
      if (!stock) continue;

      const normalizedSources = Array.isArray(item.sources)
        ? item.sources
            .map((s) => {
              const matched = resolveAttachedSource(s, attachedFiles);
              const resolvedTitle =
                matched?.videoTitle ||
                (typeof s?.videoTitle === 'string' && s.videoTitle.trim()
                  ? sanitizeRecommendationVideoTitle(undefined, s.videoTitle, 'analysis.md')
                  : fallbackSource?.videoTitle || 'Analyzed Video');
              const resolvedFileName =
                matched?.fileName ||
                (typeof s?.sourceFileName === 'string' && s.sourceFileName.trim()) ||
                fallbackSource?.fileName ||
                'analysis.md';

              return {
                videoTitle: resolvedTitle,
                sourceFileName: resolvedFileName,
                timestamps: Array.isArray(s?.timestamps)
                  ? s.timestamps
                      .map((t) => String(t || '').trim())
                      .filter((t) => Boolean(t) && !/^(none|n\/a|-)$/i.test(t))
                  : [],
                specificNotes:
                  typeof s?.specificNotes === 'string' && s.specificNotes.trim()
                    ? s.specificNotes.trim()
                    : undefined,
              };
            })
            .filter((s) => Boolean(s.videoTitle))
        : [];

      result.push({
        stock,
        atfNumber: normalizeAtfNumber(item.atfNumber),
        category,
        entryAndDipLevels:
          (typeof item.entryAndDipLevels === 'string' && item.entryAndDipLevels.trim()) ||
          'No price level given',
        targetsAndStopLoss:
          (typeof item.targetsAndStopLoss === 'string' && item.targetsAndStopLoss.trim()) ||
          'No target given',
        horizonAndGuidance:
          (typeof item.horizonAndGuidance === 'string' && item.horizonAndGuidance.trim()) ||
          'See source analysis notes.',
        hasLevelConflict: Boolean(item.hasLevelConflict),
        sources:
          normalizedSources.length > 0
            ? normalizedSources
            : [
                {
                  videoTitle: fallbackSource?.videoTitle || 'Analyzed Video',
                  sourceFileName: fallbackSource?.fileName || 'analysis.md',
                  timestamps: [],
                },
              ],
      });
    }

    // Sort by multiple sources first, then ATF # ascending, then stock name alphabetically
    return result.sort((a, b) => {
      if (b.sources.length !== a.sources.length) {
        return b.sources.length - a.sources.length;
      }
      if (a.atfNumber && !b.atfNumber) return -1;
      if (!a.atfNumber && b.atfNumber) return 1;
      return a.stock.localeCompare(b.stock);
    });
  }

  function escapeMarkdownCell(text: string): string {
    return String(text || '')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n+/g, ' ')
      .trim();
  }

  function renderEntriesMarkdownTable(entries: RecommendationEntryPayload[]): string {
    if (entries.length === 0) {
      return '_No stocks matched this category across the selected analysis.md files._';
    }
    const header =
      '| ATF # | Stock | Entry / Dip Levels | Targets & Stop-Loss | Horizon & Buying Plan | Sources & Timestamps |\n' +
      '| :--- | :--- | :--- | :--- | :--- | :--- |';
    const rows = entries.map((entry) => {
      const stockCell = entry.hasLevelConflict
        ? `**${escapeMarkdownCell(entry.stock)}** _(Multiple targets)_`
        : `**${escapeMarkdownCell(entry.stock)}**`;
      const sourcesCell = entry.sources
        .map((src) => {
          const ts = src.timestamps.length > 0 ? ` (${src.timestamps.join(', ')})` : '';
          const note = src.specificNotes ? `: ${src.specificNotes}` : '';
          return `${src.videoTitle}${ts}${note}`;
        })
        .join('; ');
      return `| ${escapeMarkdownCell(entry.atfNumber || 'Outside ATF')} | ${stockCell} | ${escapeMarkdownCell(entry.entryAndDipLevels)} | ${escapeMarkdownCell(entry.targetsAndStopLoss)} | ${escapeMarkdownCell(entry.horizonAndGuidance)} | ${escapeMarkdownCell(sourcesCell)} |`;
    });
    return `${header}\n${rows.join('\n')}`;
  }

  function renderRecommendationsMarkdown(params: {
    formattedTimestamp: string;
    engineUsed: string;
    sourceVideos: RecommendationSourceFilePayload[];
    executiveSummary: string;
    strongBuys: RecommendationEntryPayload[];
    swingTrades: RecommendationEntryPayload[];
  }): string {
    const sourcesList = params.sourceVideos
      .map(
        (s, idx) =>
          `${idx + 1}. **${s.title}** (\`${s.folderName ? `${s.folderName}/analysis.md` : s.fileName}\`)`
      )
      .join('\n');

    return [
      `# Consolidated Stock Recommendations (${params.formattedTimestamp})`,
      '',
      `- **Generated At:** ${params.formattedTimestamp}`,
      `- **AI Engine:** ${params.engineUsed}`,
      `- **Analyzed Source Files:** ${params.sourceVideos.length}`,
      '',
      '## Executive Summary',
      '',
      params.executiveSummary || 'Consolidated stock recommendations from selected analysis.md files.',
      '',
      `## 1. Strong Buys (${params.strongBuys.length})`,
      '',
      renderEntriesMarkdownTable(params.strongBuys),
      '',
      `## 2. Swing Trades (${params.swingTrades.length})`,
      '',
      renderEntriesMarkdownTable(params.swingTrades),
      '',
      '## Source analysis.md Files Included',
      '',
      sourcesList || '_None listed_',
      '',
    ].join('\n');
  }

  async function runRecommendationsWithOpenAiCompatPrimary(
    files: AttachedAnalysisFile[],
    onFirstToken?: () => void
  ): Promise<RawRecommendationJson> {
    const filesBundleText = files
      .map(
        (f) =>
          `===== SOURCE ${f.sourceId} (${f.videoTitle}) =====\n` +
          `${f.condensedMarkdown}\n` +
          `===== END ${f.sourceId} =====`
      )
      .join('\n\n');

    const endpoint = `${OPENAI_COMPAT_ANALYSIS_BASE_URL}/chat/completions`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify({
        model: OPENAI_COMPAT_ANALYSIS_MODEL,
        stream: true,
        messages: [
          {
            role: 'user',
            content: `${RECOMMENDATIONS_PROMPT}\n\n---\n\n### SOURCE ANALYSIS.MD FILES (${files.length} TOTAL):\n\n${filesBundleText}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      const compactErr = errBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
      throw new Error(`HTTP ${response.status} ${response.statusText}${compactErr ? `: ${compactErr}` : ''}`);
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    let textContent = '';

    if (contentType.includes('text/event-stream') && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let lineBuffer = '';
      let notifiedFirstToken = false;

      const processSseLine = (rawLine: string) => {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) return;
        const dataStr = line.slice(5).trim();
        if (!dataStr || dataStr === '[DONE]') return;
        try {
          const chunk = JSON.parse(dataStr) as {
            choices?: Array<{
              delta?: { content?: string | Array<{ text?: string }> | null };
              message?: { content?: string | Array<{ text?: string }> | null };
            }>;
          };
          const piece = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content;
          if (typeof piece === 'string' && piece.length > 0) {
            textContent += piece;
            if (!notifiedFirstToken) {
              notifiedFirstToken = true;
              onFirstToken?.();
            }
          } else if (Array.isArray(piece)) {
            const joined = piece.map((p) => p?.text || '').join('');
            if (joined.length > 0) {
              textContent += joined;
              if (!notifiedFirstToken) {
                notifiedFirstToken = true;
                onFirstToken?.();
              }
            }
          }
        } catch {
          // Ignore malformed keepalive or partial metadata SSE frames
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          processSseLine(line);
        }
      }
      lineBuffer += decoder.decode();
      if (lineBuffer.trim()) {
        for (const line of lineBuffer.split(/\r?\n/)) {
          processSseLine(line);
        }
      }
    } else {
      const rawBody = await response.text();
      // Handle proxies that send SSE text without setting text/event-stream header
      if (rawBody.trimStart().startsWith('data:')) {
        for (const rawLine of rawBody.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trim();
          if (!dataStr || dataStr === '[DONE]') continue;
          try {
            const chunk = JSON.parse(dataStr) as {
              choices?: Array<{ delta?: { content?: string | null } }>;
            };
            const piece = chunk.choices?.[0]?.delta?.content;
            if (typeof piece === 'string') textContent += piece;
          } catch {
            // Skip non-JSON SSE line
          }
        }
      } else {
        let parsed: {
          choices?: Array<{ message?: { content?: string | Array<{ text?: string }> | null } }>;
        };
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          throw new Error('OpenAI-compatible endpoint returned non-JSON response.');
        }
        const msgContent = parsed.choices?.[0]?.message?.content;
        textContent =
          typeof msgContent === 'string'
            ? msgContent
            : Array.isArray(msgContent)
              ? msgContent.map((part) => part?.text || '').join('\n')
              : '';
      }
    }

    if (!textContent.trim()) {
      throw new Error('OpenAI-compatible endpoint returned an empty recommendations response.');
    }
    return parseLooseJsonObject<RawRecommendationJson>(textContent);
  }

  async function runRecommendationsWithGeminiFallback(
    ai: GoogleGenAI,
    files: AttachedAnalysisFile[]
  ): Promise<RawRecommendationJson> {
    const workDir = path.join(os.tmpdir(), `cuescript_rec_${crypto.randomBytes(6).toString('hex')}`);
    await fs.mkdir(workDir, { recursive: true });
    const uploadedNames: string[] = [];

    try {
      const fileParts: Array<{ fileData: { fileUri: string; mimeType: string } }> = [];
      const manifestLines: string[] = [];

      for (let i = 0; i < files.length; i += 1) {
        const f = files[i];
        const tempFilePath = path.join(workDir, `${f.sourceId}.txt`);
        const framedContent =
          `Source ID: ${f.sourceId}\n` +
          `Source Video Title: ${f.videoTitle}\n` +
          `\n${f.condensedMarkdown}\n`;
        await fs.writeFile(tempFilePath, framedContent, 'utf-8');

        const uploaded = await ai.files.upload({
          file: tempFilePath,
          config: { mimeType: 'text/plain', displayName: `${f.sourceId}-${f.fileName}` },
        });
        if (uploaded.name) uploadedNames.push(uploaded.name);
        if (!uploaded.uri) {
          throw new Error(`Gemini Files API upload failed for ${f.fileName}.`);
        }

        fileParts.push({
          fileData: {
            fileUri: uploaded.uri,
            mimeType: uploaded.mimeType || 'text/plain',
          },
        });
        manifestLines.push(`${f.sourceId}: "${f.videoTitle}"`);
      }

      const promptWithManifest = [
        RECOMMENDATIONS_PROMPT,
        `Attached source files (${files.length}):\n${manifestLines.join('\n')}`,
      ].join('\n\n');

      const parts = [...fileParts, { text: promptWithManifest }];
      const attempts = [
        { model: GEMINI_MODEL, delayMs: 0 },
        { model: GEMINI_FALLBACK_MODEL, delayMs: 1200 },
        { model: GEMINI_FALLBACK_MODEL, delayMs: 5000 },
      ];

      let lastErr: unknown;
      for (const attempt of attempts) {
        if (attempt.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, attempt.delayMs));
        }
        try {
          const response = await ai.models.generateContent({
            model: attempt.model,
            contents: [{ role: 'user', parts }],
            config: {
              responseMimeType: 'application/json',
              responseSchema: RECOMMENDATIONS_RESPONSE_SCHEMA,
            },
          });
          const text = (response.text || '').trim();
          if (!text) {
            throw new Error('Gemini recommendations returned an empty response.');
          }
          return parseLooseJsonObject<RawRecommendationJson>(text);
        } catch (err) {
          lastErr = err;
          if (!isTransientGeminiError(err)) {
            throw err;
          }
        }
      }
      throw lastErr;
    } finally {
      for (const name of uploadedNames) {
        await ai.files.delete({ name }).catch(() => {});
      }
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  interface RecommendationJobRecord {
    recommendationJobId: string;
    status: 'processing' | 'completed' | 'failed';
    stageLabel: string;
    createdAt: number;
    recommendation?: RecommendationSnapshotPayload;
    error?: string;
  }

  const recommendationJobs = new Map<string, RecommendationJobRecord>();
  const recommendationsUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 50 },
  });

  app.get('/api/recommendations/latest', async (req: Request, res: Response) => {
    if (!isDriveBridgeConfigured()) {
      res.json({ ok: true, hasRecommendation: false });
      return;
    }
    if (!isDriveRequestAuthorized(req)) {
      res.status(401).json({ ok: false, message: 'Unlock Drive Bridge first.' });
      return;
    }
    const result = await getLatestRecommendationFromDrive();
    if (!result.ok) {
      res.json({
        ok: true,
        hasRecommendation: false,
        needsBridgeUpdate: Boolean(result.needsBridgeUpdate),
        warning: result.error,
      });
      return;
    }
    res.json({
      ok: true,
      hasRecommendation: result.hasRecommendation,
      recommendation: result.recommendation,
    });
  });

  app.post('/api/recommendations/sync', async (req: Request, res: Response) => {
    if (!isDriveBridgeConfigured()) {
      res.status(400).json({ ok: false, message: 'Google Drive Bridge is not configured.' });
      return;
    }
    if (!isDriveRequestAuthorized(req)) {
      res.status(401).json({ ok: false, message: 'Unlock Drive Bridge before syncing.' });
      return;
    }
    const snapshot = req.body?.recommendation as RecommendationSnapshotPayload | undefined;
    if (!snapshot || typeof snapshot.markdown !== 'string' || !snapshot.formattedTimestamp) {
      res.status(400).json({ ok: false, message: 'Missing valid recommendation snapshot payload.' });
      return;
    }
    const saved = await saveRecommendationToDrive(snapshot);
    if (!saved.ok) {
      res.status(saved.needsBridgeUpdate ? 422 : 502).json({
        ok: false,
        needsBridgeUpdate: Boolean(saved.needsBridgeUpdate),
        message: saved.error || 'Failed to save recommendation to Google Drive.',
      });
      return;
    }
    res.json({
      ok: true,
      driveFiles: saved.driveFiles,
      syncedAt: saved.syncedAt,
    });
  });

  app.get('/api/recommendations/jobs/:jobId', (req: Request, res: Response) => {
    const jobId = req.params.jobId || '';
    if (!/^rec_[a-f0-9]+$/i.test(jobId)) {
      res.status(400).json({ ok: false, message: 'Invalid recommendation job identifier.' });
      return;
    }
    const rec = recommendationJobs.get(jobId);
    if (!rec) {
      res.status(404).json({ ok: false, message: 'Recommendation job not found or expired.' });
      return;
    }
    res.json({
      ok: true,
      recommendationJobId: rec.recommendationJobId,
      status: rec.status,
      stageLabel: rec.stageLabel,
      recommendation: rec.recommendation,
      error: rec.error,
    });
  });

  app.post('/api/recommendations/generate', (req: Request, res: Response) => {
    recommendationsUpload.array('analysisFiles', 50)(req, res, (multerErr: unknown) => {
      if (multerErr) {
        res.status(400).json({
          ok: false,
          message: 'Could not read uploaded analysis.md files.',
        });
        return;
      }

      const uploadedFiles = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
      if (uploadedFiles.length === 0) {
        res.status(400).json({
          ok: false,
          message: 'Select at least one analyzed video with an analysis.md file before generating recommendations.',
        });
        return;
      }

      let manifestItems: Array<{
        jobId?: string;
        sourceKey?: string;
        title?: string;
        folderName?: string;
        fileName?: string;
      }> = [];
      if (typeof req.body?.manifest === 'string' && req.body.manifest.trim()) {
        try {
          const parsedManifest = JSON.parse(req.body.manifest);
          if (Array.isArray(parsedManifest)) {
            manifestItems = parsedManifest;
          }
        } catch {
          manifestItems = [];
        }
      }

      const attachedFiles: AttachedAnalysisFile[] = [];
      for (let i = 0; i < uploadedFiles.length; i += 1) {
        const file = uploadedFiles[i];
        const markdown = file.buffer.toString('utf-8').trim();
        if (!markdown) continue;
        const meta = manifestItems[i] || {};
        const fileName = (meta.fileName || file.originalname || `analysis_${i + 1}.md`).trim();
        const videoTitle = sanitizeRecommendationVideoTitle(meta.folderName, meta.title, fileName);
        const condensedMarkdown = stripNotDiscussedSection(markdown);
        attachedFiles.push({
          sourceId: `S${attachedFiles.length + 1}`,
          fileName,
          videoTitle,
          folderName: meta.folderName,
          jobId: meta.jobId,
          sourceKey: meta.sourceKey,
          markdown,
          condensedMarkdown,
          buffer: file.buffer,
        });
      }

      if (attachedFiles.length === 0) {
        res.status(400).json({
          ok: false,
          message: 'All selected analysis.md files were empty.',
        });
        return;
      }

      const rawClientTs =
        typeof req.body?.clientTimestamp === 'string' ? req.body.clientTimestamp.trim() : '';
      const formattedTimestamp = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/.test(rawClientTs)
        ? rawClientTs
        : formatRecommendationTimestamp(new Date());
      const fileBaseName = `Recommendations_${formattedTimestamp}`;
      const driveEnabled = isDriveBridgeConfigured() && isDriveRequestAuthorized(req);

      const now = Date.now();
      for (const [id, item] of recommendationJobs.entries()) {
        if (now - item.createdAt > 30 * 60 * 1000) recommendationJobs.delete(id);
      }

      const recommendationJobId = `rec_${crypto.randomBytes(8).toString('hex')}`;
      const record: RecommendationJobRecord = {
        recommendationJobId,
        status: 'processing',
        stageLabel: `Synthesizing ${attachedFiles.length} analysis.md ${attachedFiles.length === 1 ? 'file' : 'files'} with OpenAI (${OPENAI_COMPAT_ANALYSIS_MODEL})...`,
        createdAt: now,
      };
      recommendationJobs.set(recommendationJobId, record);

      res.status(202).json({
        ok: true,
        recommendationJobId,
        status: 'processing',
      });

      void (async () => {
        try {
          let rawOutput: RawRecommendationJson;
          let engineUsed = `OpenAI (${OPENAI_COMPAT_ANALYSIS_MODEL})`;

          try {
            record.stageLabel = `Synthesizing ${attachedFiles.length} analysis.md ${attachedFiles.length === 1 ? 'file' : 'files'} with OpenAI (${OPENAI_COMPAT_ANALYSIS_MODEL})...`;
            rawOutput = await runRecommendationsWithOpenAiCompatPrimary(attachedFiles, () => {
              record.stageLabel = `Streaming recommendations from OpenAI (${OPENAI_COMPAT_ANALYSIS_MODEL})...`;
            });
          } catch (primaryErr) {
            const safeReason =
              primaryErr instanceof Error ? primaryErr.message.slice(0, 140) : 'primary endpoint failed';
            console.warn(
              `OpenAI Recommendations failed (${safeReason}); falling back to Google Gemini Files API.`
            );
            record.stageLabel = `Primary API unavailable — uploading ${attachedFiles.length} files to Google Gemini...`;
            const ai = getGeminiClient();
            rawOutput = await runRecommendationsWithGeminiFallback(ai, attachedFiles);
            engineUsed = 'Google Gemini fallback';
          }

          const sourceVideos: RecommendationSourceFilePayload[] = attachedFiles.map((f) => ({
            jobId: f.jobId,
            sourceKey: f.sourceKey,
            title: f.videoTitle,
            folderName: f.folderName,
            fileName: f.fileName,
          }));

          const strongBuys = normalizeRecommendationEntries(
            rawOutput.strongBuys,
            'strong_buy',
            attachedFiles
          );
          const swingTrades = normalizeRecommendationEntries(
            rawOutput.swingTrades,
            'swing_trade',
            attachedFiles
          );
          const executiveSummary =
            (typeof rawOutput.executiveSummary === 'string' && rawOutput.executiveSummary.trim()) ||
            `Synthesized ${strongBuys.length} Strong Buy and ${swingTrades.length} Swing Trade recommendations from ${attachedFiles.length} analyzed videos.`;

          const markdown = renderRecommendationsMarkdown({
            formattedTimestamp,
            engineUsed,
            sourceVideos,
            executiveSummary,
            strongBuys,
            swingTrades,
          });

          const snapshot: RecommendationSnapshotPayload = {
            id: recommendationJobId,
            generatedAt: new Date().toISOString(),
            formattedTimestamp,
            fileBaseName,
            engineUsed,
            sourceVideos,
            executiveSummary,
            strongBuys,
            swingTrades,
            markdown,
            syncedToDrive: false,
          };

          if (driveEnabled) {
            record.stageLabel = `Saving ${fileBaseName}.md & .json to Google Drive...`;
            const driveResult = await saveRecommendationToDrive(snapshot);
            if (driveResult.ok) {
              snapshot.syncedToDrive = true;
              snapshot.driveFiles = driveResult.driveFiles;
            } else {
              snapshot.syncedToDrive = false;
              snapshot.driveSyncWarning = driveResult.error;
            }
          }

          record.recommendation = snapshot;
          record.status = 'completed';
          record.stageLabel = 'Recommendations ready';
        } catch (err) {
          const mapped = formatGeminiError(err);
          record.status = 'failed';
          record.error = mapped.message;
        }
      })();
    });
  });

  app.get('/plans/:filename', (req: Request, res: Response) => {
    const fileName = String(req.params.filename || '').trim();
    if (!/^[a-zA-Z0-9._-]+\.md$/.test(fileName)) {
      res.status(400).json({ ok: false, message: 'Invalid plan filename.' });
      return;
    }
    const plansDir = path.resolve(__dirname, 'plans');
    const resolvedPath = path.resolve(plansDir, fileName);
    if (!resolvedPath.startsWith(plansDir + path.sep) || !existsSync(resolvedPath)) {
      res.status(404).json({ ok: false, message: 'Plan document not found.' });
      return;
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    createReadStream(resolvedPath).pipe(res);
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CueScript server running on http://0.0.0.0:${PORT}`);
    // Pre-warm standalone yt-dlp_linux ELF binary in the background so first extraction is instant
    void ensureYtDlpBinary().catch((err) => {
      console.warn('Background yt-dlp_linux warm-up deferred:', err instanceof Error ? err.message : err);
    });
  });
}

startServer().catch((err) => {
  console.error('Failed to start CueScript server:', err);
  process.exit(1);
});
