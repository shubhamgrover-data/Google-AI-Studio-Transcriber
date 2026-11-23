export type MediaPlatform =
  | 'youtube'
  | 'facebook'
  | 'instagram'
  | 'direct_url'
  | 'file_upload';

export interface TranscriptSegment {
  id: string;
  startSeconds: number;
  endSeconds: number;
  speakerId: string;
  text: string;
}

export interface TranscriptChapter {
  id: string;
  title: string;
  startSeconds: number;
  endSeconds: number;
  summary: string;
}

export interface TranscriptAnalysisResult {
  markdown: string;
  engineUsed: string;
  generatedAt: string;
  referenceImageName: string;
}

export interface DriveTranscriptFileIds {
  jsonId?: string;
  srtId?: string;
  txtId?: string;
  analysisMdId?: string;
}

export interface TranscriptJob {
  id: string;
  createdAt: string;
  sourceType: MediaPlatform;
  sourceUrl?: string;
  fileName?: string;
  mimeType?: string;
  embedVideoId?: string;
  mediaKind: 'youtube' | 'video' | 'audio' | 'none';
  /** Ephemeral client-side Object URL for local playback during active session */
  localMediaUrl?: string;
  /** Public extracted media stream URL or durable Drive audio proxy URL */
  remoteMediaUrl?: string;
  thumbnailUrl?: string;
  title: string;
  author?: string;
  language: string;
  durationSeconds: number;
  summary: string;
  /** Maps canonical speakerId (e.g. "Speaker 1") to user-editable display name */
  speakers: Record<string, string>;
  chapters: TranscriptChapter[];
  segments: TranscriptSegment[];
  extractionMethod: string;
  analysis?: TranscriptAnalysisResult;
  /** Deterministic canonical key used for Google Drive cache lookup */
  sourceKey?: string;
  /** Dedicated per-video Google Drive folder ID under CueScript/ */
  driveFolderId?: string;
  /** Dedicated per-video Google Drive folder name, e.g. "FB - Video title" */
  driveFolderName?: string;
  /** Google Drive file ID of archived audio track inside the video's Drive folder */
  driveAudioFileId?: string;
  driveAudioMimeType?: string;
  driveTranscriptFileIds?: DriveTranscriptFileIds;
  syncedToDrive?: boolean;
  loadedFromCache?: boolean;
  syncedAt?: string;
}

export interface DriveStatusResponse {
  ok: true;
  configured: boolean;
  requiresPasscode: boolean;
  unlocked: boolean;
  reachable: boolean;
  folderName?: string;
  audioCount?: number;
  transcriptCount?: number;
  videoFolderCount?: number;
  configError?: string | null;
  error?: string;
}

export type RefreshMode = 'audio' | 'fresh';

export interface TranscribeApiSuccess {
  ok: true;
  job: Omit<TranscriptJob, 'localMediaUrl'>;
  fromCache?: boolean;
}

export interface TranscribeApiError {
  ok: false;
  code:
    | 'INVALID_URL'
    | 'UNSUPPORTED_PLATFORM'
    | 'LOGIN_WALL_FALLBACK'
    | 'FILE_TOO_LARGE'
    | 'UNSUPPORTED_MEDIA'
    | 'GEMINI_ERROR'
    | 'UPSTREAM_FETCH_ERROR'
    | 'SERVER_ERROR';
  platform?: MediaPlatform;
  title?: string;
  message: string;
  technicalReason?: string;
  suggestedAction?: string;
}

export interface AsyncJobAccepted {
  ok: true;
  asyncJobId: string;
  status: 'queued' | 'processing';
}

export interface AsyncJobPollResponse {
  ok: true;
  asyncJobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  stepIndex: number;
  stageLabel: string;
  progressPct: number;
  job?: Omit<TranscriptJob, 'localMediaUrl'>;
  error?: TranscribeApiError;
}

export interface AnalysisPollResponse {
  ok: true;
  analysisJobId: string;
  status: 'processing' | 'completed' | 'failed';
  stageLabel: string;
  analysis?: TranscriptAnalysisResult;
  error?: string;
}

export type TranscribeApiResponse = TranscribeApiSuccess | AsyncJobAccepted | TranscribeApiError;

export type AppView = 'studio' | 'analysis';
