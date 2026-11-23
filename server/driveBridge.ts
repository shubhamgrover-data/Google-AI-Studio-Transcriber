import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Request } from 'express';

const execFileAsync = promisify(execFile);

const MAX_BRIDGE_AUDIO_BYTES = 28 * 1024 * 1024; // ~37 MB base64 stays safely under Apps Script 50 MB POST ceiling
const DRIVE_AUDIO_CACHE_DIR = path.join(os.tmpdir(), 'cuescript_drive_audio_cache');
const SESSION_SIGNING_KEY = crypto.randomBytes(32);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface DriveTranscriptFileIds {
  jsonId?: string;
  srtId?: string;
  txtId?: string;
  analysisMdId?: string;
}

export interface DriveJobPayload {
  id: string;
  createdAt: string;
  sourceType: 'youtube' | 'facebook' | 'instagram' | 'direct_url' | 'file_upload';
  sourceUrl?: string;
  fileName?: string;
  mimeType?: string;
  embedVideoId?: string;
  mediaKind: 'youtube' | 'video' | 'audio' | 'none';
  remoteMediaUrl?: string;
  thumbnailUrl?: string;
  title: string;
  author?: string;
  language: string;
  durationSeconds: number;
  summary: string;
  speakers: Record<string, string>;
  chapters: Array<{
    id: string;
    title: string;
    startSeconds: number;
    endSeconds: number;
    summary: string;
  }>;
  segments: Array<{
    id: string;
    startSeconds: number;
    endSeconds: number;
    speakerId: string;
    text: string;
  }>;
  extractionMethod: string;
  analysis?: {
    markdown: string;
    engineUsed: string;
    generatedAt: string;
    referenceImageName: string;
  };
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

export interface DriveLookupResult {
  hasTranscript: boolean;
  hasAudio: boolean;
  transcriptJob?: DriveJobPayload;
  folderId?: string;
  folderName?: string;
  audioFile?: {
    id: string;
    name: string;
    mimeType: string;
    sizeBytes?: number;
  };
  transcriptFiles?: DriveTranscriptFileIds;
  syncedAt?: string;
}

export interface DrivePingResult {
  ok: boolean;
  folderName?: string;
  rootFolderId?: string;
  audioCount?: number;
  transcriptCount?: number;
  videoFolderCount?: number;
  error?: string;
}

export interface RecommendationSourceRefPayload {
  videoTitle: string;
  sourceFileName: string;
  timestamps: string[];
  specificNotes?: string;
}

export interface RecommendationEntryPayload {
  stock: string;
  atfNumber: string | null;
  category: 'strong_buy' | 'swing_trade';
  entryAndDipLevels: string;
  targetsAndStopLoss: string;
  horizonAndGuidance: string;
  hasLevelConflict: boolean;
  sources: RecommendationSourceRefPayload[];
}

export interface RecommendationSourceFilePayload {
  jobId?: string;
  sourceKey?: string;
  title: string;
  folderName?: string;
  fileName: string;
}

export interface RecommendationDriveFilesPayload {
  folderId?: string;
  mdFileId?: string;
  jsonFileId?: string;
  mdFileName?: string;
  jsonFileName?: string;
}

export interface RecommendationSnapshotPayload {
  id: string;
  generatedAt: string;
  formattedTimestamp: string;
  fileBaseName: string;
  engineUsed: string;
  sourceVideos: RecommendationSourceFilePayload[];
  executiveSummary: string;
  strongBuys: RecommendationEntryPayload[];
  swingTrades: RecommendationEntryPayload[];
  markdown: string;
  driveFiles?: RecommendationDriveFilesPayload;
  syncedToDrive?: boolean;
  driveSyncWarning?: string;
}

export function formatRecommendationTimestamp(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

export function getSourceShortLabel(
  sourceType: DriveJobPayload['sourceType'] | string | undefined
): string {
  switch (sourceType) {
    case 'facebook':
      return 'FB';
    case 'instagram':
      return 'Insta';
    case 'youtube':
      return 'YT';
    case 'direct_url':
      return 'URL';
    case 'file_upload':
    default:
      return 'Upload';
  }
}

export function formatDriveVideoFolderName(
  sourceType: DriveJobPayload['sourceType'] | string | undefined,
  title: string | undefined
): string {
  const prefix = getSourceShortLabel(sourceType);
  const sanitized = (title || 'Untitled Video')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50)
    .trim();
  return `${prefix} - ${sanitized || 'Untitled Video'}`;
}

function getValidatedBridgeConfig(): { url: string; secret: string } | null {
  const rawUrl = process.env.DRIVE_BRIDGE_URL?.trim() || '';
  const secret = process.env.DRIVE_BRIDGE_SECRET?.trim() || '';
  if (!rawUrl || !secret) return null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname.toLowerCase() !== 'script.google.com') return null;
  if (!parsed.pathname.startsWith('/macros/s/')) return null;

  return { url: parsed.toString(), secret };
}

export function isDriveBridgeConfigured(): boolean {
  return Boolean(getValidatedBridgeConfig());
}

export function getBridgeConfigurationError(): string | null {
  const rawUrl = process.env.DRIVE_BRIDGE_URL?.trim() || '';
  const secret = process.env.DRIVE_BRIDGE_SECRET?.trim() || '';
  if (!rawUrl && !secret) return null;
  if (!rawUrl) return 'DRIVE_BRIDGE_URL is missing in Settings > Secrets.';
  if (!secret) return 'DRIVE_BRIDGE_SECRET is missing in Settings > Secrets.';
  try {
    const parsed = new URL(rawUrl);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname.toLowerCase() !== 'script.google.com' ||
      !parsed.pathname.startsWith('/macros/s/')
    ) {
      return 'DRIVE_BRIDGE_URL must be an https://script.google.com/macros/s/.../exec Web App URL.';
    }
  } catch {
    return 'DRIVE_BRIDGE_URL is not a valid URL.';
  }
  return null;
}

export function isPasscodeRequired(): boolean {
  return Boolean(process.env.OWNER_PASSCODE?.trim());
}

export function verifyOwnerPasscode(candidate: string): boolean {
  const configured = process.env.OWNER_PASSCODE?.trim();
  if (!configured || typeof candidate !== 'string') return false;
  const expectedHash = crypto.createHash('sha256').update(configured, 'utf-8').digest();
  const candidateHash = crypto.createHash('sha256').update(candidate.trim(), 'utf-8').digest();
  return crypto.timingSafeEqual(expectedHash, candidateHash);
}

export function mintOwnerSessionToken(): string {
  const payload = JSON.stringify({
    exp: Date.now() + SESSION_TTL_MS,
    nonce: crypto.randomBytes(12).toString('hex'),
  });
  const encoded = Buffer.from(payload, 'utf-8').toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SIGNING_KEY).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyOwnerSessionToken(token: string | null | undefined): boolean {
  if (!token || typeof token !== 'string') return false;
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0) return false;
  const encoded = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expectedSig = crypto
    .createHmac('sha256', SESSION_SIGNING_KEY)
    .update(encoded)
    .digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return false;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8')) as {
      exp?: number;
    };
    return typeof parsed.exp === 'number' && parsed.exp > Date.now();
  } catch {
    return false;
  }
}

export function isDriveRequestAuthorized(req: Request): boolean {
  if (!isPasscodeRequired()) return true;
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return false;
  return verifyOwnerSessionToken(authHeader.slice(7).trim());
}

export function isValidSourceKey(key: string): boolean {
  return /^[a-z0-9_-]{4,80}$/i.test(key);
}

export function isValidDriveFileId(fileId: string): boolean {
  return /^[a-zA-Z0-9_-]{10,120}$/.test(fileId);
}

export function computeSourceKey(params: {
  platform: 'youtube' | 'facebook' | 'instagram' | 'direct_url' | 'file_upload';
  youtubeId?: string;
  parsedUrl?: URL;
  fileBuffer?: Buffer;
}): string {
  if (params.platform === 'youtube' && params.youtubeId) {
    return `yt_${params.youtubeId}`;
  }

  if (params.parsedUrl) {
    const url = new URL(params.parsedUrl.toString());
    if (params.platform === 'instagram') {
      const igMatch = url.pathname.match(/\/(?:reel|reels|p|tv)\/([a-zA-Z0-9_-]{5,40})/i);
      if (igMatch?.[1]) {
        return `ig_${igMatch[1]}`;
      }
    }

    // Strip common mobile/desktop tracking query parameters for canonical matching
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'si',
      'fbclid',
      'mibextid',
      'ref',
      'sfnsn',
      'igsh',
      'igshid',
      'feature',
    ];
    for (const p of trackingParams) {
      url.searchParams.delete(p);
    }
    url.hash = '';
    const canonical = `${url.hostname.toLowerCase().replace(/^(www|m|web)\./, '')}${url.pathname.replace(/\/+$/, '')}${url.search}`;
    const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 14);
    const prefix =
      params.platform === 'facebook'
        ? 'fb'
        : params.platform === 'instagram'
          ? 'ig'
          : 'url';
    return `${prefix}_${hash}`;
  }

  if (params.fileBuffer) {
    const hash = crypto.createHash('sha256').update(params.fileBuffer).digest('hex').slice(0, 14);
    return `upload_${hash}`;
  }

  return `job_${crypto.randomBytes(6).toString('hex')}`;
}

function isAllowedGoogleScriptHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'script.google.com' ||
    host === 'script.googleusercontent.com' ||
    host.endsWith('.googleusercontent.com')
  );
}

async function callDriveBridge<T>(
  payload: Record<string, unknown>,
  timeoutMs = 90_000
): Promise<T> {
  const config = getValidatedBridgeConfig();
  if (!config) {
    throw new Error('DRIVE_BRIDGE_NOT_CONFIGURED');
  }

  const bodyString = JSON.stringify({
    ...payload,
    secret: config.secret,
  });

  let currentUrl = config.url;
  let method: 'POST' | 'GET' = 'POST';
  let response: globalThis.Response | null = null;

  for (let hop = 0; hop <= 5; hop += 1) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== 'https:' || !isAllowedGoogleScriptHost(parsed.hostname)) {
      throw new Error('DRIVE_BRIDGE_BLOCKED_REDIRECT');
    }

    response = await fetch(currentUrl, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers:
        method === 'POST'
          ? { 'Content-Type': 'text/plain;charset=utf-8' }
          : { Accept: 'application/json' },
      body: method === 'POST' ? bodyString : undefined,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Drive bridge redirect missing Location header (HTTP ${response.status}).`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      // Google Apps Script Web Apps return 302 to script.googleusercontent.com/macros/echo expecting GET
      method = 'GET';
      continue;
    }
    break;
  }

  if (!response) {
    throw new Error('Drive bridge did not return a response.');
  }

  const rawText = await response.text();
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        'Drive bridge returned HTTP 401 (Google login required). In Apps Script -> Deploy -> Manage deployments -> Edit (pencil icon), change "Who has access" to "Anyone" (not "Only myself" or "Anyone with Google account"), select "New version", and click Deploy.'
      );
    }
    throw new Error(`Drive bridge returned HTTP ${response.status}.`);
  }

  let parsed: T & { ok?: boolean; error?: string };
  try {
    parsed = JSON.parse(rawText) as T & { ok?: boolean; error?: string };
  } catch {
    const looksLikeHtml = /<html|<!doctype/i.test(rawText);
    throw new Error(
      looksLikeHtml
        ? 'Drive bridge returned an HTML page instead of JSON. Ensure your Apps Script deployment is set to "Execute as: Me", "Who has access: Anyone", and updated to a New Version with CueScript Code.gs.'
        : 'Drive bridge returned non-JSON output.'
    );
  }

  if (parsed && typeof parsed === 'object' && 'ok' in parsed && parsed.ok === false) {
    throw new Error(parsed.error || 'Drive bridge rejected the request.');
  }

  return parsed;
}

function formatDisplayTimeServer(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${String(hours).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatSrtTimeServer(totalSeconds: number): string {
  const safe = Math.max(0, Number.isFinite(totalSeconds) ? totalSeconds : 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000) % 1000;
  return (
    `${String(hours).padStart(2, '0')}:` +
    `${String(minutes).padStart(2, '0')}:` +
    `${String(seconds).padStart(2, '0')},` +
    `${String(millis).padStart(3, '0')}`
  );
}

export function serializeTranscriptBundle(job: DriveJobPayload): {
  jsonText: string;
  srtText: string;
  txtText: string;
} {
  const getSpeaker = (speakerId: string) => job.speakers?.[speakerId]?.trim() || speakerId;

  const srtText = (job.segments || [])
    .map((seg, idx) => {
      const start = formatSrtTimeServer(seg.startSeconds);
      const end = formatSrtTimeServer(Math.max(seg.endSeconds, seg.startSeconds + 1));
      return `${idx + 1}\n${start} --> ${end}\n${getSpeaker(seg.speakerId)}: ${seg.text}`;
    })
    .join('\n\n');

  const headerLines = [
    job.title,
    job.sourceUrl ? `Source: ${job.sourceUrl}` : job.fileName ? `File: ${job.fileName}` : '',
    `Language: ${job.language} · Duration: ${formatDisplayTimeServer(job.durationSeconds)}`,
    '',
    'SUMMARY',
    job.summary,
    '',
  ]
    .filter(Boolean)
    .join('\n');

  const chaptersBlock =
    job.chapters && job.chapters.length > 0
      ? [
          'CHAPTERS',
          ...job.chapters.map(
            (ch) => `[${formatDisplayTimeServer(ch.startSeconds)}] ${ch.title} — ${ch.summary}`
          ),
          '',
        ].join('\n')
      : '';

  const transcriptBlock = [
    'TRANSCRIPT',
    ...(job.segments || []).map(
      (seg) =>
        `[${formatDisplayTimeServer(seg.startSeconds)} - ${formatDisplayTimeServer(seg.endSeconds)}] ${getSpeaker(seg.speakerId)}: ${seg.text}`
    ),
  ].join('\n');

  const txtText = `${headerLines}\n${chaptersBlock}\n${transcriptBlock}\n`;
  const jsonText = JSON.stringify(job, null, 2);

  return { jsonText, srtText, txtText };
}

export async function pingDriveBridge(): Promise<DrivePingResult> {
  try {
    const res = await callDriveBridge<DrivePingResult>({ action: 'ping' }, 20_000);
    return {
      ok: true,
      folderName: res.folderName || 'CueScript',
      rootFolderId: res.rootFolderId,
      audioCount: typeof res.audioCount === 'number' ? res.audioCount : 0,
      transcriptCount: typeof res.transcriptCount === 'number' ? res.transcriptCount : 0,
      videoFolderCount: typeof res.videoFolderCount === 'number' ? res.videoFolderCount : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unable to reach Drive Bridge.',
    };
  }
}

function hydrateAnalysisFallback(
  job: DriveJobPayload,
  analysisMd: string | null | undefined,
  syncedAt: string | undefined
): DriveJobPayload['analysis'] {
  if (job.analysis && typeof job.analysis.markdown === 'string' && job.analysis.markdown.trim()) {
    return job.analysis;
  }
  if (typeof analysisMd === 'string' && analysisMd.trim()) {
    return {
      markdown: analysisMd,
      engineUsed: 'Cached in Google Drive',
      generatedAt: syncedAt || job.syncedAt || job.createdAt,
      referenceImageName: 'ATF60Stocks.jpg',
    };
  }
  return undefined;
}

export async function lookupDriveCache(sourceKey: string): Promise<DriveLookupResult> {
  if (!isValidSourceKey(sourceKey)) {
    return { hasTranscript: false, hasAudio: false };
  }
  const res = await callDriveBridge<{
    ok: true;
    hasTranscript?: boolean;
    hasAudio?: boolean;
    transcriptJson?: string;
    analysisMd?: string | null;
    folderId?: string;
    folderName?: string;
    audioFile?: { id: string; name: string; mimeType: string; sizeBytes?: number };
    transcriptFiles?: DriveTranscriptFileIds;
    syncedAt?: string;
  }>({ action: 'lookup', sourceKey }, 25_000);

  let transcriptJob: DriveJobPayload | undefined;
  if (res.hasTranscript && typeof res.transcriptJson === 'string' && res.transcriptJson.trim()) {
    try {
      const parsed = JSON.parse(res.transcriptJson) as DriveJobPayload;
      if (parsed && typeof parsed.title === 'string' && Array.isArray(parsed.segments)) {
        const analysis = hydrateAnalysisFallback(parsed, res.analysisMd, res.syncedAt);
        transcriptJob = {
          ...parsed,
          analysis,
          sourceKey,
          driveFolderId: res.folderId || parsed.driveFolderId,
          driveFolderName: res.folderName || parsed.driveFolderName,
          driveAudioFileId: res.audioFile?.id || parsed.driveAudioFileId,
          driveAudioMimeType: res.audioFile?.mimeType || parsed.driveAudioMimeType,
          driveTranscriptFileIds: res.transcriptFiles || parsed.driveTranscriptFileIds,
          syncedToDrive: true,
          loadedFromCache: true,
          syncedAt: res.syncedAt || parsed.syncedAt,
        };
        if (
          transcriptJob.mediaKind !== 'youtube' &&
          transcriptJob.driveAudioFileId
        ) {
          transcriptJob.mediaKind = 'audio';
          transcriptJob.remoteMediaUrl = `/api/drive/audio/${transcriptJob.driveAudioFileId}`;
        }
      }
    } catch {
      transcriptJob = undefined;
    }
  }

  return {
    hasTranscript: Boolean(transcriptJob),
    hasAudio: Boolean(res.hasAudio && res.audioFile?.id),
    transcriptJob,
    folderId: res.folderId,
    folderName: res.folderName,
    audioFile: res.audioFile,
    transcriptFiles: res.transcriptFiles,
    syncedAt: res.syncedAt,
  };
}

export async function listDriveLibrary(limit = 30): Promise<DriveJobPayload[]> {
  const res = await callDriveBridge<{
    ok: true;
    items?: Array<{
      sourceKey: string;
      transcriptJson: string;
      analysisMd?: string | null;
      folderId?: string;
      folderName?: string;
      audioFileId?: string;
      audioMimeType?: string;
      transcriptFiles?: DriveTranscriptFileIds;
      updatedAt?: string;
    }>;
  }>({ action: 'list', limit }, 35_000);

  const jobs: DriveJobPayload[] = [];
  for (const item of res.items || []) {
    try {
      const parsed = JSON.parse(item.transcriptJson) as DriveJobPayload;
      if (!parsed || typeof parsed.title !== 'string' || !Array.isArray(parsed.segments)) {
        continue;
      }
      const audioFileId = item.audioFileId || parsed.driveAudioFileId;
      const analysis = hydrateAnalysisFallback(parsed, item.analysisMd, item.updatedAt);
      const hydrated: DriveJobPayload = {
        ...parsed,
        analysis,
        sourceKey: item.sourceKey || parsed.sourceKey,
        driveFolderId: item.folderId || parsed.driveFolderId,
        driveFolderName: item.folderName || parsed.driveFolderName,
        driveAudioFileId: audioFileId,
        driveAudioMimeType: item.audioMimeType || parsed.driveAudioMimeType,
        driveTranscriptFileIds: item.transcriptFiles || parsed.driveTranscriptFileIds,
        syncedToDrive: true,
        syncedAt: item.updatedAt || parsed.syncedAt || parsed.createdAt,
      };
      if (hydrated.mediaKind !== 'youtube' && audioFileId) {
        hydrated.mediaKind = 'audio';
        hydrated.remoteMediaUrl = `/api/drive/audio/${audioFileId}`;
      }
      jobs.push(hydrated);
    } catch {
      // Skip malformed JSON files in Drive folder
    }
  }

  return jobs.sort(
    (a, b) =>
      new Date(b.syncedAt || b.createdAt).getTime() -
      new Date(a.syncedAt || a.createdAt).getTime()
  );
}

function mimeToExt(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes('mp4') || lower.includes('m4a')) return '.m4a';
  if (lower.includes('mpeg') || lower.includes('mp3')) return '.mp3';
  if (lower.includes('wav')) return '.wav';
  if (lower.includes('ogg')) return '.ogg';
  if (lower.includes('webm')) return '.webm';
  return '.m4a';
}

export async function saveAudioFileToDrive(params: {
  sourceKey: string;
  audioPath: string;
  mimeType: string;
  ffmpegBin: string;
  sourceType?: DriveJobPayload['sourceType'];
  title?: string;
  folderName?: string;
}): Promise<{
  fileId: string;
  mimeType: string;
  sizeBytes: number;
  folderId?: string;
  folderName?: string;
}> {
  if (!isValidSourceKey(params.sourceKey)) {
    throw new Error('Invalid sourceKey for Drive audio save.');
  }

  let uploadPath = params.audioPath;
  let uploadMime = params.mimeType;
  let tempCompactPath: string | null = null;

  try {
    const stat = await fs.stat(uploadPath);
    if (stat.size > MAX_BRIDGE_AUDIO_BYTES) {
      // Compact long audio to 32 kbps mono speech MP3 so it fits cleanly inside Apps Script POST limits
      tempCompactPath = path.join(
        os.tmpdir(),
        `cuescript_drive_compact_${crypto.randomBytes(6).toString('hex')}.mp3`
      );
      await execFileAsync(
        params.ffmpegBin,
        [
          '-nostats',
          '-loglevel',
          'error',
          '-y',
          '-i',
          uploadPath,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-b:a',
          '32k',
          '-compression_level',
          '0',
          tempCompactPath,
        ],
        { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }
      );
      const compactStat = await fs.stat(tempCompactPath);
      if (compactStat.size > MAX_BRIDGE_AUDIO_BYTES) {
        throw new Error('Audio exceeds 28 MB compressed Drive Bridge upload limit.');
      }
      uploadPath = tempCompactPath;
      uploadMime = 'audio/mpeg';
    }

    const buffer = await fs.readFile(uploadPath);
    const ext = mimeToExt(uploadMime);
    const folderName =
      params.folderName || formatDriveVideoFolderName(params.sourceType, params.title);

    const res = await callDriveBridge<{
      ok: true;
      fileId: string;
      folderId?: string;
      folderName?: string;
      mimeType?: string;
      sizeBytes?: number;
    }>(
      {
        action: 'saveAudio',
        sourceKey: params.sourceKey,
        folderName,
        fileName: `audio${ext}`,
        mimeType: uploadMime,
        base64Data: buffer.toString('base64'),
      },
      120_000
    );

    return {
      fileId: res.fileId,
      mimeType: res.mimeType || uploadMime,
      sizeBytes: res.sizeBytes ?? buffer.byteLength,
      folderId: res.folderId,
      folderName: res.folderName || folderName,
    };
  } finally {
    if (tempCompactPath) {
      await fs.unlink(tempCompactPath).catch(() => {});
    }
  }
}

export async function saveTranscriptBundleToDrive(
  sourceKey: string,
  job: DriveJobPayload
): Promise<{
  transcriptFiles: DriveTranscriptFileIds;
  syncedAt: string;
  folderId?: string;
  folderName?: string;
}> {
  if (!isValidSourceKey(sourceKey)) {
    throw new Error('Invalid sourceKey for Drive transcript save.');
  }

  const syncedAt = new Date().toISOString();
  const folderName =
    job.driveFolderName || formatDriveVideoFolderName(job.sourceType, job.title);

  const payloadToSave: DriveJobPayload = {
    ...job,
    sourceKey,
    driveFolderName: folderName,
    syncedToDrive: true,
    syncedAt,
  };
  const { jsonText, srtText, txtText } = serializeTranscriptBundle(payloadToSave);
  const analysisMd =
    payloadToSave.analysis &&
    typeof payloadToSave.analysis.markdown === 'string' &&
    payloadToSave.analysis.markdown.trim()
      ? payloadToSave.analysis.markdown
      : undefined;

  const res = await callDriveBridge<{
    ok: true;
    folderId?: string;
    folderName?: string;
    transcriptFiles?: DriveTranscriptFileIds;
    syncedAt?: string;
  }>(
    {
      action: 'saveTranscript',
      sourceKey,
      folderName,
      jsonText,
      srtText,
      txtText,
      ...(analysisMd ? { analysisMd } : {}),
    },
    45_000
  );

  return {
    transcriptFiles: res.transcriptFiles || {},
    syncedAt: res.syncedAt || syncedAt,
    folderId: res.folderId,
    folderName: res.folderName || folderName,
  };
}

export async function downloadDriveAudioToTemp(fileId: string): Promise<{
  filePath: string;
  mimeType: string;
}> {
  if (!isValidDriveFileId(fileId)) {
    throw new Error('Invalid Google Drive fileId.');
  }

  await fs.mkdir(DRIVE_AUDIO_CACHE_DIR, { recursive: true });
  const metaPath = path.resolve(DRIVE_AUDIO_CACHE_DIR, `${fileId}.meta.json`);
  if (!metaPath.startsWith(DRIVE_AUDIO_CACHE_DIR + path.sep)) {
    throw new Error('Invalid cache path.');
  }

  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as {
        filePath?: string;
        mimeType?: string;
      };
      if (
        meta.filePath &&
        meta.filePath.startsWith(DRIVE_AUDIO_CACHE_DIR + path.sep) &&
        existsSync(meta.filePath)
      ) {
        return {
          filePath: meta.filePath,
          mimeType: meta.mimeType || 'audio/mp4',
        };
      }
    } catch {
      // Cache miss, re-download below
    }
  }

  const res = await callDriveBridge<{
    ok: true;
    base64Data: string;
    mimeType?: string;
    fileName?: string;
  }>({ action: 'getAudio', fileId }, 120_000);

  if (!res.base64Data) {
    throw new Error('Drive audio file was empty or unavailable.');
  }

  const mimeType = res.mimeType || 'audio/mp4';
  const ext = mimeToExt(mimeType);
  const audioPath = path.resolve(DRIVE_AUDIO_CACHE_DIR, `${fileId}${ext}`);
  if (!audioPath.startsWith(DRIVE_AUDIO_CACHE_DIR + path.sep)) {
    throw new Error('Invalid audio cache path.');
  }

  const bytes = Buffer.from(res.base64Data, 'base64');
  await fs.writeFile(audioPath, bytes);
  await fs.writeFile(metaPath, JSON.stringify({ filePath: audioPath, mimeType }), 'utf-8');

  return { filePath: audioPath, mimeType };
}

export async function trashDriveEntry(sourceKey: string): Promise<{ trashedCount: number }> {
  if (!isValidSourceKey(sourceKey)) {
    throw new Error('Invalid sourceKey.');
  }
  const res = await callDriveBridge<{ ok: true; trashedCount?: number }>(
    { action: 'trash', sourceKey },
    30_000
  );
  return { trashedCount: res.trashedCount ?? 0 };
}

export function isUnknownBridgeActionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /unknown action/i.test(msg);
}

export async function saveRecommendationToDrive(
  snapshot: RecommendationSnapshotPayload
): Promise<{
  ok: boolean;
  needsBridgeUpdate?: boolean;
  error?: string;
  driveFiles?: RecommendationDriveFilesPayload;
  syncedAt?: string;
}> {
  const fileBaseName =
    snapshot.fileBaseName?.trim() || `Recommendations_${snapshot.formattedTimestamp}`;

  const jsonPayload: RecommendationSnapshotPayload = {
    ...snapshot,
    fileBaseName,
    syncedToDrive: true,
    driveSyncWarning: undefined,
  };

  try {
    const res = await callDriveBridge<{
      ok: true;
      folderId?: string;
      folderName?: string;
      mdFileId?: string;
      jsonFileId?: string;
      mdFileName?: string;
      jsonFileName?: string;
      syncedAt?: string;
    }>(
      {
        action: 'saveRecommendation',
        fileBaseName,
        formattedTimestamp: snapshot.formattedTimestamp,
        mdText: snapshot.markdown,
        jsonText: JSON.stringify(jsonPayload, null, 2),
      },
      45_000
    );

    return {
      ok: true,
      driveFiles: {
        folderId: res.folderId,
        mdFileId: res.mdFileId,
        jsonFileId: res.jsonFileId,
        mdFileName: res.mdFileName || `${fileBaseName}.md`,
        jsonFileName: res.jsonFileName || `${fileBaseName}.json`,
      },
      syncedAt: res.syncedAt || new Date().toISOString(),
    };
  } catch (err) {
    if (isUnknownBridgeActionError(err)) {
      return {
        ok: false,
        needsBridgeUpdate: true,
        error:
          'Your deployed Apps Script Drive Bridge needs a quick update to save CueScript/Recommendations/ files. Open Drive Setup, copy the updated Code.gs, and deploy a New Version.',
      };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not save recommendation to Google Drive.',
    };
  }
}

export async function getLatestRecommendationFromDrive(): Promise<{
  ok: boolean;
  hasRecommendation: boolean;
  needsBridgeUpdate?: boolean;
  recommendation?: RecommendationSnapshotPayload;
  error?: string;
}> {
  try {
    const res = await callDriveBridge<{
      ok: true;
      hasRecommendation?: boolean;
      folderId?: string;
      jsonText?: string | null;
      mdText?: string | null;
      jsonFileId?: string;
      mdFileId?: string;
      jsonFileName?: string;
      mdFileName?: string;
      modifiedTime?: string;
    }>({ action: 'getLatestRecommendation' }, 30_000);

    if (!res.hasRecommendation) {
      return { ok: true, hasRecommendation: false };
    }

    if (typeof res.jsonText === 'string' && res.jsonText.trim()) {
      try {
        const parsed = JSON.parse(res.jsonText) as RecommendationSnapshotPayload;
        if (parsed && Array.isArray(parsed.strongBuys) && Array.isArray(parsed.swingTrades)) {
          const driveFiles: RecommendationDriveFilesPayload = {
            folderId: res.folderId || parsed.driveFiles?.folderId,
            mdFileId: res.mdFileId || parsed.driveFiles?.mdFileId,
            jsonFileId: res.jsonFileId || parsed.driveFiles?.jsonFileId,
            mdFileName: res.mdFileName || parsed.driveFiles?.mdFileName,
            jsonFileName: res.jsonFileName || parsed.driveFiles?.jsonFileName,
          };
          return {
            ok: true,
            hasRecommendation: true,
            recommendation: {
              ...parsed,
              markdown: parsed.markdown || res.mdText || '',
              driveFiles,
              syncedToDrive: true,
              driveSyncWarning: undefined,
            },
          };
        }
      } catch {
        // Fall through to markdown-only hydration below if JSON was malformed
      }
    }

    if (typeof res.mdText === 'string' && res.mdText.trim()) {
      const baseName = (res.mdFileName || 'Recommendations').replace(/\.md$/i, '');
      const tsMatch = baseName.replace(/^Recommendations_/i, '');
      return {
        ok: true,
        hasRecommendation: true,
        recommendation: {
          id: `drive_${res.mdFileId || Date.now()}`,
          generatedAt: res.modifiedTime || new Date().toISOString(),
          formattedTimestamp: tsMatch || formatRecommendationTimestamp(),
          fileBaseName: baseName,
          engineUsed: 'Loaded from Google Drive',
          sourceVideos: [],
          executiveSummary: 'Loaded latest archived Recommendations markdown from Google Drive.',
          strongBuys: [],
          swingTrades: [],
          markdown: res.mdText,
          driveFiles: {
            folderId: res.folderId,
            mdFileId: res.mdFileId,
            mdFileName: res.mdFileName,
          },
          syncedToDrive: true,
        },
      };
    }

    return { ok: true, hasRecommendation: false };
  } catch (err) {
    if (isUnknownBridgeActionError(err)) {
      return {
        ok: false,
        hasRecommendation: false,
        needsBridgeUpdate: true,
        error:
          'Update your Apps Script Code.gs from Drive Setup (Deploy -> New Version) to load archived recommendations from CueScript/Recommendations/.',
      };
    }
    return {
      ok: false,
      hasRecommendation: false,
      error: err instanceof Error ? err.message : 'Unable to fetch latest recommendation from Drive.',
    };
  }
}

export const APPS_SCRIPT_MANIFEST_JSON = `{
  "timeZone": "Asia/Kolkata",
  "dependencies": {
    "enabledAdvancedServices": [
      {
        "userSymbol": "Drive",
        "serviceId": "drive",
        "version": "v3"
      }
    ]
  },
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE_ANONYMOUS"
  },
  "oauthScopes": [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/script.external_request"
  ]
}
`;

export const APPS_SCRIPT_BRIDGE_CODE = `/**
 * CueScript Personal Google Drive Cache Bridge (Code.gs)
 * Per-Video Folder Architecture — Scoped strictly to https://www.googleapis.com/auth/drive.file
 * (Uses Drive REST API v3 — zero DriveApp calls, zero full-Drive access!)
 *
 * Folder layout inside Google Drive:
 *   CueScript/
 *     ├── FB - <Title up to 50 chars>/
 *     │     ├── audio.m4a (or .mp3)
 *     │     ├── transcript.json
 *     │     ├── transcript.srt
 *     │     ├── transcript.txt
 *     │     └── analysis.md (when Gen AI Analysis is run)
 *     ├── Insta - <Title up to 50 chars>/
 *     │     └── ...
 *     └── Recommendations/
 *           ├── Recommendations_dd/mm/yyyy HH:MM:SS.md
 *           └── Recommendations_dd/mm/yyyy HH:MM:SS.json
 */

var ROOT_FOLDER_NAME = 'CueScript';
var RECOMMENDATIONS_FOLDER_NAME = 'Recommendations';
var LEGACY_AUDIO_FOLDER_NAME = 'Audio';
var LEGACY_TRANSCRIPTS_FOLDER_NAME = 'Transcripts';
var DRIVE_API = 'https://www.googleapis.com/drive/v3';
var DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return jsonOut({
    ok: true,
    service: 'CueScript Google Drive Bridge (drive.file scoped · per-video folders)',
    message: 'Bridge is online. Use authenticated POST requests from the CueScript server.'
  });
}

function driveFetch(url, options) {
  var opts = options || {};
  var headers = opts.headers || {};
  headers['Authorization'] = 'Bearer ' + ScriptApp.getOAuthToken();
  opts.headers = headers;
  opts.muteHttpExceptions = true;

  var res = UrlFetchApp.fetch(url, opts);
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Drive API HTTP ' + code + ': ' + res.getContentText().slice(0, 300));
  }
  return res;
}

function driveJson(url, options) {
  var res = driveFetch(url, options);
  var text = res.getContentText('UTF-8');
  return text ? JSON.parse(text) : {};
}

function escapeQueryValue(val) {
  return String(val).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
}

function getFileMeta(fileId) {
  try {
    return driveJson(
      DRIVE_API + '/files/' + encodeURIComponent(fileId) +
      '?fields=id,name,mimeType,size,modifiedTime,trashed,parents,appProperties'
    );
  } catch (e) {
    return null;
  }
}

function listFilesByQuery(q, pageSize, orderBy) {
  var url =
    DRIVE_API + '/files?q=' + encodeURIComponent(q) +
    '&fields=' + encodeURIComponent('files(id,name,mimeType,size,modifiedTime,parents,appProperties)') +
    '&pageSize=' + String(pageSize || 100);
  if (orderBy) {
    url += '&orderBy=' + encodeURIComponent(orderBy);
  }
  var data = driveJson(url);
  return data.files || [];
}

function listFilesInFolder(folderId, extraQuery, pageSize) {
  var q = "'" + escapeQueryValue(folderId) + "' in parents and trashed = false";
  if (extraQuery) {
    q += ' and ' + extraQuery;
  }
  return listFilesByQuery(q, pageSize || 100, 'modifiedTime desc');
}

function getOrCreateRootFolder() {
  var props = PropertiesService.getScriptProperties();
  var cachedId = props.getProperty('CUESCRIPT_ROOT_FOLDER_ID');
  if (cachedId) {
    var existingMeta = getFileMeta(cachedId);
    if (existingMeta && !existingMeta.trashed && existingMeta.mimeType === 'application/vnd.google-apps.folder') {
      return existingMeta.id;
    }
  }

  var q = "name = '" + escapeQueryValue(ROOT_FOLDER_NAME) + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  var found = listFilesByQuery(q, 10, null);
  if (found.length > 0) {
    props.setProperty('CUESCRIPT_ROOT_FOLDER_ID', found[0].id);
    return found[0].id;
  }

  var created = driveJson(DRIVE_API + '/files?fields=id,name', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({
      name: ROOT_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder'
    })
  });
  props.setProperty('CUESCRIPT_ROOT_FOLDER_ID', created.id);
  return created.id;
}

function sanitizeFolderName(raw, fallback) {
  var cleaned = String(raw || '')
    .replace(/[\\\\/:*?"<>|\\r\\n\\t]+/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned || String(fallback || 'CueScript Video');
}

function findVideoFolderBySourceKey(rootId, sourceKey) {
  var q =
    "'" + escapeQueryValue(rootId) + "' in parents" +
    " and mimeType = 'application/vnd.google-apps.folder'" +
    " and trashed = false" +
    " and appProperties has { key='cuescriptSourceKey' and value='" + escapeQueryValue(sourceKey) + "' }";
  var matches = listFilesByQuery(q, 5, 'modifiedTime desc');
  return matches.length > 0 ? matches[0] : null;
}

function resolveUniqueFolderName(rootId, desiredName, excludeFolderId) {
  var base = sanitizeFolderName(desiredName, 'CueScript Video');
  var existingFolders = listFilesByQuery(
    "'" + escapeQueryValue(rootId) + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    200,
    null
  );
  var taken = {};
  for (var i = 0; i < existingFolders.length; i++) {
    var f = existingFolders[i];
    if (excludeFolderId && f.id === excludeFolderId) continue;
    if (f.name) taken[f.name.toLowerCase()] = true;
  }
  if (!taken[base.toLowerCase()]) {
    return base;
  }
  for (var n = 2; n <= 99; n++) {
    var candidate = base + ' (' + n + ')';
    if (!taken[candidate.toLowerCase()]) {
      return candidate;
    }
  }
  return base + ' (' + String(Date.now()).slice(-4) + ')';
}

function getOrCreateVideoFolder(rootId, sourceKey, desiredFolderName) {
  var existing = findVideoFolderBySourceKey(rootId, sourceKey);
  var cleanDesired = desiredFolderName ? sanitizeFolderName(desiredFolderName, sourceKey) : '';

  if (existing) {
    // If folder was created with a raw sourceKey placeholder earlier, upgrade its name cleanly
    if (cleanDesired && existing.name === sourceKey && cleanDesired !== existing.name) {
      var upgradedName = resolveUniqueFolderName(rootId, cleanDesired, existing.id);
      var updated = driveJson(DRIVE_API + '/files/' + encodeURIComponent(existing.id) + '?fields=id,name', {
        method: 'patch',
        contentType: 'application/json; charset=UTF-8',
        payload: JSON.stringify({ name: upgradedName })
      });
      return { id: updated.id, name: updated.name };
    }
    return { id: existing.id, name: existing.name };
  }

  var uniqueName = resolveUniqueFolderName(rootId, cleanDesired || sourceKey, null);
  var created = driveJson(DRIVE_API + '/files?fields=id,name', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({
      name: uniqueName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [rootId],
      appProperties: {
        cuescriptSourceKey: sourceKey,
        cuescriptType: 'video_folder'
      }
    })
  });
  return { id: created.id, name: created.name };
}

// Read-only lookup for legacy CueScript/Audio or CueScript/Transcripts folders (never creates new ones)
function findLegacySubfolder(rootId, folderName) {
  var q =
    "'" + escapeQueryValue(rootId) + "' in parents" +
    " and name = '" + escapeQueryValue(folderName) + "'" +
    " and mimeType = 'application/vnd.google-apps.folder'" +
    " and trashed = false";
  var matches = listFilesByQuery(q, 5, null);
  for (var i = 0; i < matches.length; i++) {
    var ap = matches[i].appProperties || {};
    if (!ap.cuescriptSourceKey && ap.cuescriptType !== 'recommendations_folder') {
      return matches[i];
    }
  }
  return null;
}

function findRecommendationsFolder(rootId) {
  var qByProp =
    "'" + escapeQueryValue(rootId) + "' in parents" +
    " and mimeType = 'application/vnd.google-apps.folder'" +
    " and trashed = false" +
    " and appProperties has { key='cuescriptType' and value='recommendations_folder' }";
  var propMatches = listFilesByQuery(qByProp, 5, 'modifiedTime desc');
  if (propMatches.length > 0) return propMatches[0];

  var qByName =
    "'" + escapeQueryValue(rootId) + "' in parents" +
    " and name = '" + escapeQueryValue(RECOMMENDATIONS_FOLDER_NAME) + "'" +
    " and mimeType = 'application/vnd.google-apps.folder'" +
    " and trashed = false";
  var nameMatches = listFilesByQuery(qByName, 5, 'modifiedTime desc');
  return nameMatches.length > 0 ? nameMatches[0] : null;
}

function getOrCreateRecommendationsFolder(rootId) {
  var existing = findRecommendationsFolder(rootId);
  if (existing) {
    return { id: existing.id, name: existing.name };
  }
  var created = driveJson(DRIVE_API + '/files?fields=id,name', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({
      name: RECOMMENDATIONS_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [rootId],
      appProperties: {
        cuescriptType: 'recommendations_folder'
      }
    })
  });
  return { id: created.id, name: created.name };
}

function isSafeKey(key) {
  return typeof key === 'string' && /^[a-zA-Z0-9_-]{4,80}$/.test(key);
}

function trashFileById(fileId) {
  driveJson(DRIVE_API + '/files/' + encodeURIComponent(fileId) + '?fields=id,trashed', {
    method: 'patch',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({ trashed: true })
  });
}

function uploadResumableBytes(folderId, fileName, mimeType, bytes, existingFileId, appProperties) {
  var initUrl;
  var initMethod;
  var initMeta;

  if (existingFileId) {
    initUrl = DRIVE_UPLOAD_API + '/files/' + encodeURIComponent(existingFileId) + '?uploadType=resumable&fields=id,name,mimeType,size,modifiedTime';
    initMethod = 'patch';
    initMeta = { name: fileName, mimeType: mimeType };
    if (appProperties) initMeta.appProperties = appProperties;
  } else {
    initUrl = DRIVE_UPLOAD_API + '/files?uploadType=resumable&fields=id,name,mimeType,size,modifiedTime';
    initMethod = 'post';
    initMeta = { name: fileName, parents: [folderId], mimeType: mimeType };
    if (appProperties) initMeta.appProperties = appProperties;
  }

  var initRes = driveFetch(initUrl, {
    method: initMethod,
    contentType: 'application/json; charset=UTF-8',
    headers: {
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(bytes.length)
    },
    payload: JSON.stringify(initMeta)
  });

  var headers = initRes.getHeaders();
  var uploadUrl = headers['Location'] || headers['location'];
  if (!uploadUrl) {
    throw new Error('Drive resumable upload did not return a Location header.');
  }

  var putRes = UrlFetchApp.fetch(uploadUrl, {
    method: 'put',
    contentType: mimeType,
    payload: bytes,
    muteHttpExceptions: true
  });
  var putCode = putRes.getResponseCode();
  if (putCode < 200 || putCode >= 300) {
    throw new Error('Drive upload PUT HTTP ' + putCode + ': ' + putRes.getContentText().slice(0, 300));
  }
  return JSON.parse(putRes.getContentText('UTF-8'));
}

function replaceOrCreateRoleFile(folderId, sourceKey, role, fileName, bytes, mimeType) {
  var files = listFilesInFolder(folderId, null, 50);
  var matches = [];
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var ap = f.appProperties || {};
    if (ap.cuescriptRole === role || f.name === fileName) {
      matches.push(f);
    }
  }
  var existingId = matches.length > 0 ? matches[0].id : null;
  for (var j = 1; j < matches.length; j++) {
    trashFileById(matches[j].id);
  }
  return uploadResumableBytes(folderId, fileName, mimeType, bytes, existingId, {
    cuescriptSourceKey: sourceKey,
    cuescriptRole: role
  });
}

function replaceOrCreateTextRoleFile(folderId, sourceKey, role, fileName, text, mimeType) {
  var bytes = Utilities.newBlob(String(text || ''), mimeType).getBytes();
  return replaceOrCreateRoleFile(folderId, sourceKey, role, fileName, bytes, mimeType);
}

function downloadFileText(fileId) {
  var res = driveFetch(DRIVE_API + '/files/' + encodeURIComponent(fileId) + '?alt=media');
  return res.getContentText('UTF-8');
}

function downloadFileBase64(fileId) {
  var res = driveFetch(DRIVE_API + '/files/' + encodeURIComponent(fileId) + '?alt=media');
  return Utilities.base64Encode(res.getBlob().getBytes());
}

function classifyFolderFiles(files) {
  var result = {
    jsonFile: null,
    srtFile: null,
    txtFile: null,
    analysisFile: null,
    audioFile: null
  };
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var role = (f.appProperties && f.appProperties.cuescriptRole) || '';
    var name = String(f.name || '').toLowerCase();
    if (!result.jsonFile && (role === 'transcript_json' || name === 'transcript.json' || name.slice(-5) === '.json')) {
      result.jsonFile = f;
    } else if (!result.srtFile && (role === 'transcript_srt' || name === 'transcript.srt' || name.slice(-4) === '.srt')) {
      result.srtFile = f;
    } else if (!result.txtFile && (role === 'transcript_txt' || name === 'transcript.txt' || name.slice(-4) === '.txt')) {
      result.txtFile = f;
    } else if (!result.analysisFile && (role === 'analysis_md' || name === 'analysis.md' || name.slice(-3) === '.md')) {
      result.analysisFile = f;
    } else if (
      !result.audioFile &&
      (role === 'audio' ||
        name.indexOf('audio.') === 0 ||
        (f.mimeType && (f.mimeType.indexOf('audio/') === 0 || f.mimeType.indexOf('video/') === 0)))
    ) {
      result.audioFile = f;
    }
  }
  return result;
}

function findLegacyFilesByPrefix(folderId, prefix) {
  if (!folderId) return [];
  var files = listFilesInFolder(folderId, "name contains '" + escapeQueryValue(prefix) + "'", 20);
  var exact = [];
  for (var i = 0; i < files.length; i++) {
    if (files[i].name && files[i].name.indexOf(prefix) === 0) {
      exact.push(files[i]);
    }
  }
  return exact;
}

function doPost(e) {
  try {
    var raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    var body = JSON.parse(raw);

    var expectedSecret = PropertiesService.getScriptProperties().getProperty('BRIDGE_SECRET');
    if (!expectedSecret) {
      return jsonOut({
        ok: false,
        error: 'BRIDGE_SECRET is not set in Apps Script Project Settings -> Script Properties.'
      });
    }
    if (!body || body.secret !== expectedSecret) {
      return jsonOut({ ok: false, error: 'Unauthorized: invalid BRIDGE_SECRET.' });
    }

    var rootId = getOrCreateRootFolder();
    var action = body.action;

    if (action === 'ping') {
      var subFolders = listFilesByQuery(
        "'" + escapeQueryValue(rootId) + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        200,
        'modifiedTime desc'
      );
      var videoFolders = [];
      var legacyAudioId = null;
      var legacyTranscriptsId = null;
      for (var s = 0; s < subFolders.length; s++) {
        var sf = subFolders[s];
        var ap = sf.appProperties || {};
        if (ap.cuescriptSourceKey) {
          videoFolders.push(sf);
        } else if (sf.name === LEGACY_AUDIO_FOLDER_NAME) {
          legacyAudioId = sf.id;
        } else if (sf.name === LEGACY_TRANSCRIPTS_FOLDER_NAME) {
          legacyTranscriptsId = sf.id;
        }
      }

      var allFiles = listFilesByQuery(
        "mimeType != 'application/vnd.google-apps.folder' and trashed = false",
        500,
        null
      );
      var audioCount = 0;
      var legacyJsonCount = 0;
      for (var fIdx = 0; fIdx < allFiles.length; fIdx++) {
        var file = allFiles[fIdx];
        var fRole = (file.appProperties && file.appProperties.cuescriptRole) || '';
        var parents = file.parents || [];
        if (
          fRole === 'audio' ||
          (legacyAudioId && parents.indexOf(legacyAudioId) !== -1)
        ) {
          audioCount++;
        } else if (
          legacyTranscriptsId &&
          parents.indexOf(legacyTranscriptsId) !== -1 &&
          file.name &&
          file.name.slice(-5) === '.json'
        ) {
          legacyJsonCount++;
        }
      }

      return jsonOut({
        ok: true,
        folderName: ROOT_FOLDER_NAME,
        rootFolderId: rootId,
        videoFolderCount: videoFolders.length,
        audioCount: audioCount,
        transcriptCount: videoFolders.length + legacyJsonCount
      });
    }

    if (action === 'lookup') {
      var key = body.sourceKey;
      if (!isSafeKey(key)) return jsonOut({ ok: false, error: 'Invalid sourceKey.' });

      var videoFolder = findVideoFolderBySourceKey(rootId, key);
      if (videoFolder) {
        var folderFiles = listFilesInFolder(videoFolder.id, null, 50);
        var classified = classifyFolderFiles(folderFiles);
        return jsonOut({
          ok: true,
          folderId: videoFolder.id,
          folderName: videoFolder.name,
          hasTranscript: Boolean(classified.jsonFile),
          hasAudio: Boolean(classified.audioFile),
          transcriptJson: classified.jsonFile ? downloadFileText(classified.jsonFile.id) : null,
          analysisMd: classified.analysisFile ? downloadFileText(classified.analysisFile.id) : null,
          syncedAt: classified.jsonFile ? classified.jsonFile.modifiedTime : videoFolder.modifiedTime,
          transcriptFiles: {
            jsonId: classified.jsonFile ? classified.jsonFile.id : undefined,
            srtId: classified.srtFile ? classified.srtFile.id : undefined,
            txtId: classified.txtFile ? classified.txtFile.id : undefined,
            analysisMdId: classified.analysisFile ? classified.analysisFile.id : undefined
          },
          audioFile: classified.audioFile ? {
            id: classified.audioFile.id,
            name: classified.audioFile.name,
            mimeType: classified.audioFile.mimeType,
            sizeBytes: classified.audioFile.size ? Number(classified.audioFile.size) : undefined
          } : null
        });
      }

      // Backward-compatible read fallback for earlier legacy Audio/ & Transcripts/ folders
      var legacyT = findLegacySubfolder(rootId, LEGACY_TRANSCRIPTS_FOLDER_NAME);
      var legacyA = findLegacySubfolder(rootId, LEGACY_AUDIO_FOLDER_NAME);
      var lJsonList = legacyT ? listFilesInFolder(legacyT.id, "name = '" + escapeQueryValue(key + '.json') + "'", 5) : [];
      var lSrtList = legacyT ? listFilesInFolder(legacyT.id, "name = '" + escapeQueryValue(key + '.srt') + "'", 5) : [];
      var lTxtList = legacyT ? listFilesInFolder(legacyT.id, "name = '" + escapeQueryValue(key + '.txt') + "'", 5) : [];
      var lAudioList = legacyA ? findLegacyFilesByPrefix(legacyA.id, key + '.') : [];
      var lJson = lJsonList.length > 0 ? lJsonList[0] : null;
      var lSrt = lSrtList.length > 0 ? lSrtList[0] : null;
      var lTxt = lTxtList.length > 0 ? lTxtList[0] : null;
      var lAudio = lAudioList.length > 0 ? lAudioList[0] : null;

      return jsonOut({
        ok: true,
        hasTranscript: Boolean(lJson),
        hasAudio: Boolean(lAudio),
        transcriptJson: lJson ? downloadFileText(lJson.id) : null,
        syncedAt: lJson ? lJson.modifiedTime : null,
        transcriptFiles: {
          jsonId: lJson ? lJson.id : undefined,
          srtId: lSrt ? lSrt.id : undefined,
          txtId: lTxt ? lTxt.id : undefined
        },
        audioFile: lAudio ? {
          id: lAudio.id,
          name: lAudio.name,
          mimeType: lAudio.mimeType,
          sizeBytes: lAudio.size ? Number(lAudio.size) : undefined
        } : null
      });
    }

    if (action === 'list') {
      var limit = Math.min(Math.max(Number(body.limit) || 30, 1), 60);
      var childFolders = listFilesByQuery(
        "'" + escapeQueryValue(rootId) + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        100,
        'modifiedTime desc'
      );

      var videoFolderList = [];
      var legacyAudioFolderId = null;
      var legacyTranscriptsFolderId = null;
      for (var cf = 0; cf < childFolders.length; cf++) {
        var folder = childFolders[cf];
        var fProps = folder.appProperties || {};
        if (fProps.cuescriptSourceKey) {
          videoFolderList.push(folder);
        } else if (folder.name === LEGACY_AUDIO_FOLDER_NAME) {
          legacyAudioFolderId = folder.id;
        } else if (folder.name === LEGACY_TRANSCRIPTS_FOLDER_NAME) {
          legacyTranscriptsFolderId = folder.id;
        }
      }

      // Single metadata query fetches all files inside CueScript's drive.file scope
      var allNonFolderFiles = listFilesByQuery(
        "mimeType != 'application/vnd.google-apps.folder' and trashed = false",
        500,
        'modifiedTime desc'
      );
      var filesByParent = {};
      for (var afIdx = 0; afIdx < allNonFolderFiles.length; afIdx++) {
        var nf = allNonFolderFiles[afIdx];
        var nfParents = nf.parents || [];
        for (var pIdx = 0; pIdx < nfParents.length; pIdx++) {
          var pid = nfParents[pIdx];
          if (!filesByParent[pid]) filesByParent[pid] = [];
          filesByParent[pid].push(nf);
        }
      }

      var items = [];
      var seenKeys = {};

      for (var vfIdx = 0; vfIdx < videoFolderList.length && items.length < limit; vfIdx++) {
        var vf = videoFolderList[vfIdx];
        var vKey = vf.appProperties.cuescriptSourceKey;
        var vFiles = classifyFolderFiles(filesByParent[vf.id] || []);
        if (!vFiles.jsonFile) continue;

        var jsonStr = downloadFileText(vFiles.jsonFile.id);
        var analysisStr = null;
        if (vFiles.analysisFile && jsonStr.indexOf('"analysis"') === -1) {
          analysisStr = downloadFileText(vFiles.analysisFile.id);
        }
        seenKeys[vKey] = true;
        items.push({
          sourceKey: vKey,
          folderId: vf.id,
          folderName: vf.name,
          transcriptJson: jsonStr,
          analysisMd: analysisStr,
          audioFileId: vFiles.audioFile ? vFiles.audioFile.id : undefined,
          audioMimeType: vFiles.audioFile ? vFiles.audioFile.mimeType : undefined,
          transcriptFiles: {
            jsonId: vFiles.jsonFile.id,
            srtId: vFiles.srtFile ? vFiles.srtFile.id : undefined,
            txtId: vFiles.txtFile ? vFiles.txtFile.id : undefined,
            analysisMdId: vFiles.analysisFile ? vFiles.analysisFile.id : undefined
          },
          updatedAt: vFiles.jsonFile.modifiedTime || vf.modifiedTime
        });
      }

      // Append any unmigrated legacy items so previously saved transcripts still appear
      if (legacyTranscriptsFolderId && items.length < limit) {
        var legacyAudioMap = {};
        var legacyAudios = legacyAudioFolderId ? (filesByParent[legacyAudioFolderId] || []) : [];
        for (var la = 0; la < legacyAudios.length; la++) {
          var laf = legacyAudios[la];
          var dot = laf.name ? laf.name.lastIndexOf('.') : -1;
          if (dot > 0) {
            legacyAudioMap[laf.name.slice(0, dot)] = { id: laf.id, mimeType: laf.mimeType };
          }
        }
        var legacyTranscripts = filesByParent[legacyTranscriptsFolderId] || [];
        for (var lt = 0; lt < legacyTranscripts.length && items.length < limit; lt++) {
          var ltf = legacyTranscripts[lt];
          if (!ltf.name || ltf.name.slice(-5) !== '.json') continue;
          var legacyKey = ltf.name.slice(0, -5);
          if (seenKeys[legacyKey]) continue;
          var linked = legacyAudioMap[legacyKey];
          items.push({
            sourceKey: legacyKey,
            transcriptJson: downloadFileText(ltf.id),
            audioFileId: linked ? linked.id : undefined,
            audioMimeType: linked ? linked.mimeType : undefined,
            transcriptFiles: { jsonId: ltf.id },
            updatedAt: ltf.modifiedTime
          });
        }
      }

      return jsonOut({ ok: true, items: items });
    }

    if (action === 'saveAudio') {
      var aKey = body.sourceKey;
      if (!isSafeKey(aKey)) return jsonOut({ ok: false, error: 'Invalid sourceKey.' });
      var mimeType = String(body.mimeType || 'audio/mp4');
      var fileName = String(body.fileName || 'audio.m4a').replace(/[^a-zA-Z0-9._-]/g, '');
      var bytes = Utilities.base64Decode(String(body.base64Data || ''));

      var audioTargetFolder = getOrCreateVideoFolder(rootId, aKey, body.folderName);

      // Trash any previous audio file in this video's folder (in case extension changed)
      var existingFiles = listFilesInFolder(audioTargetFolder.id, null, 50);
      for (var k = 0; k < existingFiles.length; k++) {
        var ef = existingFiles[k];
        var efRole = (ef.appProperties && ef.appProperties.cuescriptRole) || '';
        if (efRole === 'audio' || (ef.name && ef.name.toLowerCase().indexOf('audio.') === 0)) {
          trashFileById(ef.id);
        }
      }

      var uploaded = uploadResumableBytes(audioTargetFolder.id, fileName, mimeType, bytes, null, {
        cuescriptSourceKey: aKey,
        cuescriptRole: 'audio'
      });
      return jsonOut({
        ok: true,
        fileId: uploaded.id,
        folderId: audioTargetFolder.id,
        folderName: audioTargetFolder.name,
        mimeType: uploaded.mimeType || mimeType,
        sizeBytes: uploaded.size ? Number(uploaded.size) : bytes.length
      });
    }

    if (action === 'saveTranscript') {
      var tKey = body.sourceKey;
      if (!isSafeKey(tKey)) return jsonOut({ ok: false, error: 'Invalid sourceKey.' });

      var videoDir = getOrCreateVideoFolder(rootId, tKey, body.folderName);
      var savedJson = replaceOrCreateTextRoleFile(videoDir.id, tKey, 'transcript_json', 'transcript.json', body.jsonText, 'application/json');
      var savedSrt = replaceOrCreateTextRoleFile(videoDir.id, tKey, 'transcript_srt', 'transcript.srt', body.srtText, 'text/plain');
      var savedTxt = replaceOrCreateTextRoleFile(videoDir.id, tKey, 'transcript_txt', 'transcript.txt', body.txtText, 'text/plain');
      var savedAnalysis = null;
      if (typeof body.analysisMd === 'string' && body.analysisMd.trim()) {
        savedAnalysis = replaceOrCreateTextRoleFile(videoDir.id, tKey, 'analysis_md', 'analysis.md', body.analysisMd, 'text/markdown');
      }

      return jsonOut({
        ok: true,
        folderId: videoDir.id,
        folderName: videoDir.name,
        syncedAt: savedJson.modifiedTime || new Date().toISOString(),
        transcriptFiles: {
          jsonId: savedJson.id,
          srtId: savedSrt.id,
          txtId: savedTxt.id,
          analysisMdId: savedAnalysis ? savedAnalysis.id : undefined
        }
      });
    }

    if (action === 'getAudio') {
      var fileId = String(body.fileId || '');
      if (!/^[a-zA-Z0-9_-]{10,120}$/.test(fileId)) {
        return jsonOut({ ok: false, error: 'Invalid fileId.' });
      }
      var meta = getFileMeta(fileId);
      if (!meta || meta.trashed) {
        return jsonOut({ ok: false, error: 'Audio file not found or in Drive Trash.' });
      }
      var parents = meta.parents || [];
      var insideWorkspace = false;
      for (var p = 0; p < parents.length; p++) {
        var parentMeta = getFileMeta(parents[p]);
        if (parentMeta && !parentMeta.trashed && parentMeta.parents && parentMeta.parents.indexOf(rootId) !== -1) {
          insideWorkspace = true;
          break;
        }
      }
      if (!insideWorkspace) {
        return jsonOut({ ok: false, error: 'Access denied: file is outside CueScript workspace.' });
      }

      return jsonOut({
        ok: true,
        fileName: meta.name,
        mimeType: meta.mimeType || 'audio/mp4',
        base64Data: downloadFileBase64(fileId)
      });
    }

    if (action === 'trash') {
      var dKey = body.sourceKey;
      if (!isSafeKey(dKey)) return jsonOut({ ok: false, error: 'Invalid sourceKey.' });

      var trashedCount = 0;
      var folderToTrash = findVideoFolderBySourceKey(rootId, dKey);
      if (folderToTrash) {
        trashFileById(folderToTrash.id);
        trashedCount++;
      }

      // Also clean up any legacy files matching this sourceKey if present
      var legA = findLegacySubfolder(rootId, LEGACY_AUDIO_FOLDER_NAME);
      if (legA) {
        var legAudioMatches = findLegacyFilesByPrefix(legA.id, dKey + '.');
        for (var m = 0; m < legAudioMatches.length; m++) {
          trashFileById(legAudioMatches[m].id);
          trashedCount++;
        }
      }
      var legT = findLegacySubfolder(rootId, LEGACY_TRANSCRIPTS_FOLDER_NAME);
      if (legT) {
        var legTMatches = findLegacyFilesByPrefix(legT.id, dKey + '.');
        for (var n = 0; n < legTMatches.length; n++) {
          trashFileById(legTMatches[n].id);
          trashedCount++;
        }
      }

      return jsonOut({ ok: true, trashedCount: trashedCount });
    }

    if (action === 'saveRecommendation') {
      var rawBaseName = String(body.fileBaseName || '').trim();
      if (!rawBaseName || rawBaseName.length > 90 || rawBaseName.indexOf('Recommendations_') !== 0) {
        return jsonOut({ ok: false, error: 'Invalid recommendation fileBaseName.' });
      }
      var safeBaseName = rawBaseName.replace(/[\\r\\n\\t]+/g, ' ').trim();
      var recFolder = getOrCreateRecommendationsFolder(rootId);

      var mdFileName = safeBaseName + '.md';
      var jsonFileName = safeBaseName + '.json';
      var mdBytes = Utilities.newBlob(String(body.mdText || ''), 'text/markdown').getBytes();
      var jsonBytes = Utilities.newBlob(String(body.jsonText || '{}'), 'application/json').getBytes();

      var savedMd = uploadResumableBytes(recFolder.id, mdFileName, 'text/markdown', mdBytes, null, {
        cuescriptRole: 'recommendation_md',
        cuescriptRecBaseName: safeBaseName
      });
      var savedJson = uploadResumableBytes(recFolder.id, jsonFileName, 'application/json', jsonBytes, null, {
        cuescriptRole: 'recommendation_json',
        cuescriptRecBaseName: safeBaseName
      });

      return jsonOut({
        ok: true,
        folderId: recFolder.id,
        folderName: recFolder.name,
        mdFileId: savedMd.id,
        jsonFileId: savedJson.id,
        mdFileName: savedMd.name || mdFileName,
        jsonFileName: savedJson.name || jsonFileName,
        syncedAt: savedJson.modifiedTime || savedMd.modifiedTime || new Date().toISOString()
      });
    }

    if (action === 'getLatestRecommendation') {
      var existingRecFolder = findRecommendationsFolder(rootId);
      if (!existingRecFolder) {
        return jsonOut({ ok: true, hasRecommendation: false });
      }
      var recFiles = listFilesInFolder(existingRecFolder.id, null, 40);
      if (!recFiles || recFiles.length === 0) {
        return jsonOut({ ok: true, hasRecommendation: false });
      }

      var latestJson = null;
      var latestMd = null;
      for (var rIdx = 0; rIdx < recFiles.length; rIdx++) {
        var rf = recFiles[rIdx];
        var rRole = (rf.appProperties && rf.appProperties.cuescriptRole) || '';
        var rName = String(rf.name || '').toLowerCase();
        if (!latestJson && (rRole === 'recommendation_json' || rName.slice(-5) === '.json')) {
          latestJson = rf;
        } else if (!latestMd && (rRole === 'recommendation_md' || rName.slice(-3) === '.md')) {
          latestMd = rf;
        }
        if (latestJson && latestMd) break;
      }

      if (!latestJson && !latestMd) {
        return jsonOut({ ok: true, hasRecommendation: false });
      }

      // If we found a latest JSON, try to pair its matching .md file by base name
      if (latestJson) {
        var jsonBase = (latestJson.appProperties && latestJson.appProperties.cuescriptRecBaseName) ||
          String(latestJson.name || '').replace(/\\.json$/i, '');
        for (var mIdx = 0; mIdx < recFiles.length; mIdx++) {
          var cand = recFiles[mIdx];
          var cBase = (cand.appProperties && cand.appProperties.cuescriptRecBaseName) ||
            String(cand.name || '').replace(/\\.md$/i, '');
          if (String(cand.name || '').toLowerCase().slice(-3) === '.md' && cBase === jsonBase) {
            latestMd = cand;
            break;
          }
        }
      }

      return jsonOut({
        ok: true,
        hasRecommendation: true,
        folderId: existingRecFolder.id,
        jsonFileId: latestJson ? latestJson.id : undefined,
        jsonFileName: latestJson ? latestJson.name : undefined,
        mdFileId: latestMd ? latestMd.id : undefined,
        mdFileName: latestMd ? latestMd.name : undefined,
        jsonText: latestJson ? downloadFileText(latestJson.id) : null,
        mdText: latestMd ? downloadFileText(latestMd.id) : null,
        modifiedTime: (latestJson && latestJson.modifiedTime) || (latestMd && latestMd.modifiedTime) || new Date().toISOString()
      });
    }

    return jsonOut({ ok: false, error: 'Unknown action: ' + String(action) });
  } catch (err) {
    return jsonOut({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}
`;


