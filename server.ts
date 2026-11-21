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
import Groq from 'groq-sdk';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

dotenv.config();

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 25 MB upload limit
const MAX_EXTRACTED_AUDIO_BYTES = 80 * 1024 * 1024; // 80 MB (~5 hours of 32kbps mono speech MP3)
const INLINE_MEDIA_LIMIT_BYTES = 10 * 1024 * 1024; // 10 MB inline; larger uses Gemini Files API
const GROQ_WHISPER_MODEL = 'whisper-large-v3';
const GROQ_MAX_SINGLE_FILE_BYTES = 18 * 1024 * 1024; // Keep well under Groq 25 MB file limit
const GROQ_CHUNK_DURATION_SECONDS = 900; // 15-minute chunks (~3.6 MB each at 32 kbps mono MP3)
const DEEPGRAM_MODEL = 'nova-3';
const DEEPGRAM_LISTEN_ENDPOINT = 'https://api.deepgram.com/v1/listen';
const DEEPGRAM_MAX_SINGLE_FILE_BYTES = 30 * 1024 * 1024; // Stream directly up to 30 MB; chunk larger files
const DEEPGRAM_CHUNK_DURATION_SECONDS = 1200; // 20-minute chunks for very large files
const GEMINI_MODEL = 'gemini-4-hydrogen';
const YTDLP_BIN_PATH = path.join(os.tmpdir(), 'cuescript-yt-dlp');
const YTDLP_DOWNLOAD_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

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
    return YTDLP_BIN_PATH;
  }
  if (!ytdlpReadyPromise) {
    ytdlpReadyPromise = (async () => {
      // Reuse /tmp/yt-dlp if present, otherwise download latest official standalone yt-dlp
      const legacyPath = '/tmp/yt-dlp';
      if (existsSync(legacyPath)) {
        await fs.copyFile(legacyPath, YTDLP_BIN_PATH);
        await fs.chmod(YTDLP_BIN_PATH, 0o755);
        return YTDLP_BIN_PATH;
      }
      const res = await fetch(YTDLP_DOWNLOAD_URL, {
        redirect: 'follow',
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch yt-dlp binary (HTTP ${res.status})`);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(YTDLP_BIN_PATH, bytes);
      await fs.chmod(YTDLP_BIN_PATH, 0o755);
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
    await execFileAsync(
      ytdlpBin,
      [
        '--no-playlist',
        '--no-warnings',
        '--write-info-json',
        '--max-filesize',
        '150M',
        '-f',
        'bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best',
        '-o',
        outputTemplate,
        '--',
        targetUrl,
      ],
      {
        timeout: 90000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );

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
          'ffmpeg',
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
            'ffmpeg',
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
        'ffmpeg',
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
      'ffmpeg',
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
    'ffmpeg',
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
          'ffmpeg',
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
          'ffmpeg',
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

  app.post('/api/transcribe/url', (req: Request, res: Response) => {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
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
    const record = createAsyncJob(`Preparing ${platform} transcription pipeline...`);
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
                record.job = normalizeTranscriptResult(
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
                  }
                );
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
          record.job = normalizeTranscriptResult(parsed, {
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

            record.job = normalizeTranscriptResult(
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
              }
            );
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

          record.job = normalizeTranscriptResult(parsed, {
            sourceType: platform,
            sourceUrl: parsedUrl.toString(),
            mimeType,
            mediaKind: mimeType.startsWith('audio/') ? 'audio' : 'video',
            remoteMediaUrl: extracted.mediaUrl,
            thumbnailUrl: extracted.thumbnailUrl,
            fallbackTitle: extracted.title || parsed.title || `${platformLabel} Video Transcript`,
            extractionMethod: `${engineLabel} via public ${platform} OpenGraph stream`,
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

        record.job = normalizeTranscriptResult(parsed, {
          sourceType: 'direct_url',
          sourceUrl: parsedUrl.toString(),
          fileName: urlFilename,
          mimeType,
          mediaKind: mimeType.startsWith('audio/') ? 'audio' : 'video',
          remoteMediaUrl: parsedUrl.toString(),
          fallbackTitle: parsed.title || urlFilename,
          extractionMethod: `${engineLabel} via direct media stream`,
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

          record.job = normalizeTranscriptResult(parsed, {
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
  });
}

startServer().catch((err) => {
  console.error('Failed to start CueScript server:', err);
  process.exit(1);
});
