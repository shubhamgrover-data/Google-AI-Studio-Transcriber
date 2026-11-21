import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, FormEvent } from 'react';
import { AlertTriangle, ArrowRight, FileAudio, Link2, Loader2, Upload } from 'lucide-react';
import type { MediaPlatform, TranscribeApiError } from '../types/transcript';
import { detectPlatformFromInput } from '../utils/exporters';

interface IngestPanelProps {
  isProcessing: boolean;
  processingStep: number;
  processingDetail?: string;
  progressPct?: number;
  errorState: TranscribeApiError | null;
  onSubmitUrl: (url: string) => void;
  onUploadFile: (file: File, context?: { sourceUrl?: string; sourcePlatform?: MediaPlatform }) => void;
  onInspectPlatforms: () => void;
  compact?: boolean;
}

const PIPELINE_STEPS = [
  'Validating source & platform',
  'Extracting & normalizing audio (yt-dlp + FFmpeg)',
  'Transcribing speech & diarizing speakers',
  'Building chapter timeline & exports',
];

const ACCEPTED_EXTENSIONS = '.mp4,.mov,.webm,.mp3,.wav,.m4a,.ogg,.aac,audio/*,video/*';

export function IngestPanel({
  isProcessing,
  processingStep,
  processingDetail,
  progressPct = 0,
  errorState,
  onSubmitUrl,
  onUploadFile,
  onInspectPlatforms,
  compact = false,
}: IngestPanelProps) {
  const [mode, setMode] = useState<'url' | 'upload'>('url');
  const [urlInput, setUrlInput] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const detected = detectPlatformFromInput(urlInput);
  const isLoginWallFallback = errorState?.code === 'LOGIN_WALL_FALLBACK';

  function handleUrlFormSubmit(e: FormEvent) {
    e.preventDefault();
    if (!urlInput.trim() || isProcessing) return;
    onSubmitUrl(urlInput.trim());
  }

  function handleSelectedFile(file: File | undefined) {
    if (!file || isProcessing) return;
    onUploadFile(
      file,
      isLoginWallFallback && urlInput.trim()
        ? {
            sourceUrl: urlInput.trim(),
            sourcePlatform: errorState.platform,
          }
        : undefined
    );
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    handleSelectedFile(e.target.files?.[0]);
    e.target.value = '';
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    handleSelectedFile(e.dataTransfer.files?.[0]);
  }

  return (
    <section
      aria-label="Video link and media ingestion"
      className={`rounded-xl border border-[#E2E8F0] bg-white ${compact ? 'p-4 sm:p-5' : 'p-6 sm:p-8'}`}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1
            className={`font-semibold tracking-tight text-[#0F172A] ${
              compact ? 'text-lg' : 'text-2xl sm:text-3xl'
            }`}
          >
            {compact ? 'Transcribe another video link or file' : 'Send a video link. Get a timestamped transcript.'}
          </h1>
          {!compact && (
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-[#475569]">
              Supports public YouTube URLs directly, public Facebook and Instagram stream extraction, and instant local video or audio fallback when Meta gates a clip behind login.
            </p>
          )}
        </div>

        {/* Interactive mode switch */}
        <div
          role="tablist"
          aria-label="Ingestion method"
          className="inline-flex shrink-0 items-center gap-1 self-start rounded-lg bg-[#F1F5F9] p-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'url'}
            onClick={() => setMode('url')}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors duration-150 cursor-pointer ${
              mode === 'url'
                ? 'bg-white text-[#0F172A] shadow-xs'
                : 'text-[#475569] hover:text-[#0F172A]'
            }`}
          >
            <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
            Paste Link
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'upload'}
            onClick={() => setMode('upload')}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors duration-150 cursor-pointer ${
              mode === 'upload'
                ? 'bg-white text-[#0F172A] shadow-xs'
                : 'text-[#475569] hover:text-[#0F172A]'
            }`}
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            Upload Media
          </button>
        </div>
      </div>

      {/* Primary Input Area */}
      {mode === 'url' ? (
        <form onSubmit={handleUrlFormSubmit} className="mt-5">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <label htmlFor="video-url-input" className="sr-only">
                Video URL from YouTube, Facebook, Instagram, or direct media link
              </label>
              <input
                id="video-url-input"
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                disabled={isProcessing}
                placeholder="https://www.youtube.com/watch?v=...  or Facebook / Instagram link"
                className="h-12 w-full rounded-lg border border-[#CBD5E1] bg-white px-4 pr-28 text-sm text-[#0F172A] placeholder:text-[#94A3B8] transition-colors focus:border-[#0F172A] disabled:bg-[#F8FAFC] disabled:text-[#64748B]"
              />
              {detected.label && (
                <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-xs text-[#475569]">
                  {detected.label}
                </span>
              )}
            </div>
            <button
              type="submit"
              disabled={isProcessing || !urlInput.trim()}
              className="inline-flex h-12 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-[#E11D48] px-6 text-sm font-medium text-white transition-colors duration-150 hover:bg-[#BE123C] disabled:cursor-not-allowed disabled:bg-[#CBD5E1] disabled:text-[#64748B] cursor-pointer"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Transcribing
                </>
              ) : (
                <>
                  Transcribe Link
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </>
              )}
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#64748B]">
            <span>YouTube watch, Shorts, youtu.be</span>
            <span aria-hidden="true">·</span>
            <span>Facebook public videos &amp; Reels</span>
            <span aria-hidden="true">·</span>
            <span>Instagram public Reels</span>
            <span aria-hidden="true">·</span>
            <span>Direct MP4 / MP3 / WAV links</span>
          </div>
        </form>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={`mt-5 flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-8 text-center transition-colors ${
            isDragging
              ? 'border-[#E11D48] bg-[#FFF1F2]'
              : 'border-[#CBD5E1] bg-[#F8FAFC] hover:border-[#94A3B8]'
          }`}
        >
          <FileAudio className="h-6 w-6 text-[#475569]" aria-hidden="true" />
          <p className="mt-2.5 text-sm font-medium text-[#0F172A]">
            Drop a video or audio file here to transcribe with clickable timestamps
          </p>
          <p className="mt-1 text-xs text-[#64748B]">
            MP4, MOV, WebM, MP3, WAV, M4A · Up to 25 MB · Stays synced to local browser playback
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_EXTENSIONS}
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="button"
            disabled={isProcessing}
            onClick={() => fileInputRef.current?.click()}
            className="mt-4 inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-[#0F172A] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#1E293B] disabled:opacity-50 cursor-pointer"
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            Select Media File
          </button>
        </div>
      )}

      {/* Live Pipeline Progress */}
      {isProcessing && (
        <div
          role="status"
          aria-live="polite"
          className="mt-5 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-[#0F172A]">
              {processingDetail || 'Running transcription pipeline'}
            </span>
            <span className="font-mono text-xs tabular-nums text-[#475569]">
              Step {Math.min(processingStep + 1, PIPELINE_STEPS.length)} of {PIPELINE_STEPS.length}
              {progressPct > 0 ? ` · ${Math.round(progressPct)}%` : ''}
            </span>
          </div>
          <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-[#E2E8F0]">
            <div
              className="h-full rounded-full bg-[#E11D48] transition-all duration-300"
              style={{ width: `${Math.max(8, Math.min(100, progressPct || (processingStep + 1) * 20))}%` }}
            />
          </div>
          <ol className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {PIPELINE_STEPS.map((label, index) => {
              const done = index < processingStep;
              const active = index === processingStep;
              return (
                <li
                  key={label}
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors ${
                    active
                      ? 'border-[#0F172A] bg-white font-medium text-[#0F172A]'
                      : done
                      ? 'border-[#E2E8F0] bg-white text-[#15803D]'
                      : 'border-transparent bg-transparent text-[#64748B]'
                  }`}
                >
                  <span className="font-mono tabular-nums">
                    {done ? '✓' : `0${index + 1}`}
                  </span>
                  <span className="truncate">{label}</span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {/* Error or Meta Login-Wall Fallback Panel */}
      {errorState && !isProcessing && (
        <div
          role="alert"
          className={`mt-5 rounded-lg border p-4 ${
            isLoginWallFallback
              ? 'border-[#FDE68A] bg-[#FFFBEB]'
              : 'border-[#FECDD3] bg-[#FFF1F2]'
          }`}
        >
          <div className="flex items-start gap-3">
            <AlertTriangle
              className={`mt-0.5 h-4 w-4 shrink-0 ${
                isLoginWallFallback ? 'text-[#B45309]' : 'text-[#BE123C]'
              }`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p
                className={`text-sm font-semibold ${
                  isLoginWallFallback ? 'text-[#78350F]' : 'text-[#881337]'
                }`}
              >
                {errorState.message}
              </p>
              {errorState.technicalReason && (
                <p className="mt-1 font-mono text-xs text-[#475569]">
                  Diagnostic: {errorState.technicalReason}
                </p>
              )}
              {errorState.suggestedAction && (
                <p className="mt-1.5 text-xs leading-relaxed text-[#475569]">
                  {errorState.suggestedAction}
                </p>
              )}

              {isLoginWallFallback && (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ACCEPTED_EXTENSIONS}
                    onChange={handleFileChange}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-[#0F172A] px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-[#1E293B] cursor-pointer"
                  >
                    <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                    Upload Downloaded Clip Now
                  </button>
                  <button
                    type="button"
                    onClick={onInspectPlatforms}
                    className="whitespace-nowrap text-xs font-medium text-[#78350F] underline underline-offset-4 hover:text-[#451A03] cursor-pointer"
                  >
                    Why Meta blocks servers &amp; how to fix in production
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
