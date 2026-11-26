import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  Clock,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  HardDrive,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { AskAiContext } from '../types/askAi';
import type { RefreshMode, TranscriptJob } from '../types/transcript';
import { buildStudioTranscriptAskAiContext } from '../utils/askAiContexts';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import {
  formatDisplayTimestamp,
  getSpeakerDisplayName,
  serializeToJSON,
  serializeToSRT,
  serializeToTXT,
  serializeToVTT,
  slugifyFilename,
  triggerFileDownload,
  truncateTitle,
} from '../utils/exporters';

interface StudioWorkspaceProps {
  job: TranscriptJob;
  onRenameSpeaker: (speakerId: string, newName: string) => void;
  onDeleteJob: (jobId: string, deleteFromDrive: boolean) => Promise<void> | void;
  onRefreshTranscript: (job: TranscriptJob, mode: RefreshMode) => void;
  isRefreshing: boolean;
  refreshDetail?: string;
  refreshProgressPct?: number;
  refreshError?: string | null;
  onDismissRefreshError?: () => void;
  driveEnabled: boolean;
  driveSessionToken: string | null;
  onOpenAskAi: (context: AskAiContext) => void;
}

const PLATFORM_LABELS: Record<TranscriptJob['sourceType'], string> = {
  youtube: 'YouTube',
  facebook: 'Facebook',
  instagram: 'Instagram',
  direct_url: 'Direct Media',
  file_upload: 'Uploaded Media',
};

export function StudioWorkspace({
  job,
  onRenameSpeaker,
  onDeleteJob,
  onRefreshTranscript,
  isRefreshing,
  refreshDetail,
  refreshProgressPct = 0,
  refreshError,
  onDismissRefreshError,
  driveEnabled,
  driveSessionToken,
  onOpenAskAi,
}: StudioWorkspaceProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSpeaker, setSelectedSpeaker] = useState<string>('ALL');
  const [currentTime, setCurrentTime] = useState(0);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [editingSpeakerId, setEditingSpeakerId] = useState<string | null>(null);
  const [speakerDraft, setSpeakerDraft] = useState('');
  const [copiedState, setCopiedState] = useState<string | null>(null);
  const [ytSeekTime, setYtSeekTime] = useState<number | null>(null);
  const [showRefreshMenu, setShowRefreshMenu] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [authedDriveBlobUrl, setAuthedDriveBlobUrl] = useState<string | null>(null);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const mediaElRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const refreshMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSearchQuery('');
    setSelectedSpeaker('ALL');
    setCurrentTime(0);
    setActiveSegmentId(null);
    setEditingSpeakerId(null);
    setYtSeekTime(null);
    setShowRefreshMenu(false);
  }, [job.id]);

  // Close reload popover when clicking outside
  useEffect(() => {
    if (!showRefreshMenu) return;
    function handleOutsideClick(e: MouseEvent) {
      if (refreshMenuRef.current && !refreshMenuRef.current.contains(e.target as Node)) {
        setShowRefreshMenu(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [showRefreshMenu]);

  // When OWNER_PASSCODE is active, fetch protected Drive audio via Bearer token into an in-memory Blob URL
  useEffect(() => {
    const needsAuthedFetch =
      job.mediaKind !== 'youtube' &&
      !job.localMediaUrl &&
      Boolean(driveSessionToken) &&
      Boolean(job.remoteMediaUrl?.startsWith('/api/drive/audio/'));

    if (!needsAuthedFetch || !job.remoteMediaUrl || !driveSessionToken) {
      setAuthedDriveBlobUrl(null);
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;

    fetch(job.remoteMediaUrl, {
      headers: { Authorization: `Bearer ${driveSessionToken}` },
    })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!blob || cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setAuthedDriveBlobUrl(createdUrl);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [job.id, job.mediaKind, job.localMediaUrl, job.remoteMediaUrl, driveSessionToken]);

  useEffect(() => {
    if (job.mediaKind !== 'youtube') return;

    function handleMessage(event: MessageEvent) {
      if (typeof event.data !== 'string') return;
      if (!event.origin.includes('youtube.com') && !event.origin.includes('youtube-nocookie.com')) {
        return;
      }
      try {
        const parsed = JSON.parse(event.data) as {
          event?: string;
          info?: { currentTime?: number };
        };
        if (parsed.info && typeof parsed.info.currentTime === 'number') {
          setCurrentTime(parsed.info.currentTime);
        }
      } catch {
        // Ignore unrelated postMessage frames
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [job.mediaKind]);

  const syncedSegmentId = useMemo(() => {
    if (currentTime <= 0 && !activeSegmentId) return null;
    const match = job.segments.find(
      (seg) => currentTime >= seg.startSeconds && currentTime < seg.endSeconds
    );
    return match?.id ?? activeSegmentId;
  }, [currentTime, job.segments, activeSegmentId]);

  const speakerIds = useMemo(() => Object.keys(job.speakers), [job.speakers]);

  const filteredSegments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return job.segments.filter((seg) => {
      if (selectedSpeaker !== 'ALL' && seg.speakerId !== selectedSpeaker) {
        return false;
      }
      if (!q) return true;
      const speakerLabel = getSpeakerDisplayName(job, seg.speakerId).toLowerCase();
      return seg.text.toLowerCase().includes(q) || speakerLabel.includes(q);
    });
  }, [job, searchQuery, selectedSpeaker]);

  const wordCount = useMemo(
    () =>
      job.segments.reduce(
        (sum, seg) => sum + seg.text.split(/\s+/).filter(Boolean).length,
        0
      ),
    [job.segments]
  );

  function seekTo(seconds: number, segmentId?: string) {
    const target = Math.max(0, Math.floor(seconds));
    setCurrentTime(target);
    if (segmentId) setActiveSegmentId(segmentId);

    if (job.mediaKind === 'youtube' && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: 'seekTo', args: [target, true] }),
        '*'
      );
      iframeRef.current.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: 'playVideo', args: [] }),
        '*'
      );
      setYtSeekTime(target);
      return;
    }

    if (mediaElRef.current) {
      mediaElRef.current.currentTime = target;
      mediaElRef.current.play().catch(() => {});
    }
  }

  function handleExport(format: 'srt' | 'vtt' | 'txt' | 'json') {
    const slug = slugifyFilename(job.title);
    if (format === 'srt') {
      triggerFileDownload(serializeToSRT(job), `${slug}.srt`, 'application/x-subrip;charset=utf-8');
    } else if (format === 'vtt') {
      triggerFileDownload(serializeToVTT(job), `${slug}.vtt`, 'text/vtt;charset=utf-8');
    } else if (format === 'txt') {
      triggerFileDownload(serializeToTXT(job), `${slug}.txt`, 'text/plain;charset=utf-8');
    } else {
      triggerFileDownload(serializeToJSON(job), `${slug}.json`, 'application/json;charset=utf-8');
    }
    setCopiedState(`Saved .${format}`);
    setTimeout(() => setCopiedState(null), 2000);
  }

  async function handleCopyTranscript() {
    try {
      await navigator.clipboard.writeText(serializeToTXT(job));
      setCopiedState('Copied text');
      setTimeout(() => setCopiedState(null), 2000);
    } catch {
      setCopiedState('Copy unavailable');
      setTimeout(() => setCopiedState(null), 2000);
    }
  }

  function beginRename(speakerId: string) {
    setEditingSpeakerId(speakerId);
    setSpeakerDraft(getSpeakerDisplayName(job, speakerId));
  }

  function commitRename(speakerId: string) {
    const trimmed = speakerDraft.trim();
    if (trimmed) {
      onRenameSpeaker(speakerId, trimmed);
    }
    setEditingSpeakerId(null);
  }

  const playableSrc =
    job.localMediaUrl ||
    authedDriveBlobUrl ||
    (job.remoteMediaUrl?.startsWith('/api/drive/audio/') && driveSessionToken
      ? undefined
      : job.remoteMediaUrl);

  const canRefreshFromUrl = Boolean(job.sourceUrl);
  const canRefreshFromCachedAudio = Boolean(job.sourceUrl && job.driveAudioFileId && driveEnabled);
  const isDriveBacked = Boolean(job.syncedToDrive && job.sourceKey && driveEnabled);

  function handleTriggerDelete() {
    if (isDriveBacked) {
      setPendingDelete(true);
    } else {
      void onDeleteJob(job.id, false);
    }
  }

  async function handleConfirmDelete(deleteFromDrive: boolean) {
    setIsDeleting(true);
    try {
      await onDeleteJob(job.id, deleteFromDrive);
      setPendingDelete(false);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <section aria-label="Transcript studio workbench" className="space-y-6">
      {/* Job Title & Unboxed Metadata Strip */}
      <div className="space-y-4 border-b border-[#E2E8F0] pb-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h2
              title={job.title}
              className="text-xl font-semibold tracking-tight text-[#0F172A] sm:text-2xl"
            >
              {truncateTitle(job.title, 50)}
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-[#475569]">
              <span className="font-medium text-[#0F172A]">{PLATFORM_LABELS[job.sourceType]}</span>
              {job.author && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{job.author}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span>{job.language}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                {formatDisplayTimestamp(job.durationSeconds)}
              </span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">
                {speakerIds.length} {speakerIds.length === 1 ? 'speaker' : 'speakers'}
              </span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{wordCount.toLocaleString()} words</span>
              {job.syncedToDrive && (
                <>
                  <span aria-hidden="true">·</span>
                  <span
                    title={
                      job.driveFolderName
                        ? `CueScript/${job.driveFolderName}/`
                        : 'Saved in Google Drive (CueScript/)'
                    }
                    className="inline-flex items-center gap-1 font-medium text-[#16A34A]"
                  >
                    <HardDrive className="h-3 w-3" aria-hidden="true" />
                    {job.loadedFromCache ? 'Cached in Drive' : 'Saved to Drive'}
                  </span>
                </>
              )}
              {job.sourceUrl && (
                <>
                  <span aria-hidden="true">·</span>
                  <a
                    href={job.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[#0F172A] underline underline-offset-4 hover:text-[#E11D48]"
                  >
                    Open source
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                </>
              )}
            </div>
          </div>

          {/* Export, Reload & Delete Controls */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => handleExport('srt')}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#CBD5E1] bg-white px-3 py-2 text-xs font-medium text-[#0F172A] transition-colors hover:border-[#0F172A] cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              SRT
            </button>
            <button
              type="button"
              onClick={() => handleExport('vtt')}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#CBD5E1] bg-white px-3 py-2 text-xs font-medium text-[#0F172A] transition-colors hover:border-[#0F172A] cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              VTT
            </button>
            <button
              type="button"
              onClick={() => handleExport('txt')}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#CBD5E1] bg-white px-3 py-2 text-xs font-medium text-[#0F172A] transition-colors hover:border-[#0F172A] cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              TXT
            </button>
            <button
              type="button"
              onClick={() => handleExport('json')}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#CBD5E1] bg-white px-3 py-2 text-xs font-medium text-[#0F172A] transition-colors hover:border-[#0F172A] cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              JSON
            </button>
            <button
              type="button"
              onClick={handleCopyTranscript}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-[#0F172A] px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-[#1E293B] cursor-pointer"
            >
              {copiedState ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                  {copiedState}
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  Copy
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => onOpenAskAi(buildStudioTranscriptAskAiContext(job))}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-[#E11D48] px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-[#BE123C] cursor-pointer"
            >
              <Bot className="h-3.5 w-3.5" aria-hidden="true" />
              Chat with transcript
            </button>

            {/* Reload Icon Button to Refresh Cached / Existing Transcript */}
            {canRefreshFromUrl && (
              <div ref={refreshMenuRef} className="relative">
                <button
                  type="button"
                  disabled={isRefreshing}
                  onClick={() => setShowRefreshMenu((prev) => !prev)}
                  aria-label="Refresh transcript"
                  aria-expanded={showRefreshMenu}
                  title="Refresh transcript"
                  className={`inline-flex items-center justify-center rounded-lg border bg-white p-2 transition-colors disabled:opacity-60 cursor-pointer ${
                    showRefreshMenu || isRefreshing
                      ? 'border-[#0F172A] text-[#0F172A]'
                      : 'border-[#CBD5E1] text-[#334155] hover:border-[#0F172A] hover:text-[#0F172A]'
                  }`}
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin text-[#E11D48]' : ''}`}
                    aria-hidden="true"
                  />
                </button>

                {showRefreshMenu && !isRefreshing && (
                  <div
                    role="menu"
                    aria-label="Transcript refresh options"
                    className="absolute right-0 z-30 mt-2 w-72 overflow-hidden rounded-xl border border-[#E2E8F0] bg-white p-1.5 shadow-lg"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!canRefreshFromCachedAudio}
                      onClick={() => {
                        setShowRefreshMenu(false);
                        onRefreshTranscript(job, 'audio');
                      }}
                      className="flex w-full flex-col items-start rounded-lg px-3 py-2 text-left transition-colors hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
                    >
                      <span className="text-xs font-semibold text-[#0F172A]">
                        Re-transcribe cached Drive audio
                      </span>
                      <span className="mt-0.5 text-[11px] leading-snug text-[#64748B]">
                        {canRefreshFromCachedAudio
                          ? 'Skips video download · regenerates transcript & updates Drive'
                          : 'No cached Drive audio available for this clip'}
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setShowRefreshMenu(false);
                        onRefreshTranscript(job, 'fresh');
                      }}
                      className="mt-0.5 flex w-full flex-col items-start rounded-lg px-3 py-2 text-left transition-colors hover:bg-[#F8FAFC] cursor-pointer"
                    >
                      <span className="text-xs font-semibold text-[#0F172A]">
                        Re-extract &amp; transcribe fresh
                      </span>
                      <span className="mt-0.5 text-[11px] leading-snug text-[#64748B]">
                        Downloads audio from the original link and refreshes Drive cache
                      </span>
                    </button>
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={handleTriggerDelete}
              aria-label="Delete transcript"
              title="Delete transcript"
              className="inline-flex items-center justify-center rounded-lg border border-[#E2E8F0] bg-white p-2 text-[#64748B] transition-colors hover:border-[#FECDD3] hover:text-[#BE123C] cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Inline Refresh Progress Bar */}
        {isRefreshing && (
          <div
            role="status"
            aria-live="polite"
            className="rounded-lg border border-[#E2E8F0] bg-white p-3.5"
          >
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="inline-flex items-center gap-2 font-medium text-[#0F172A]">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#E11D48]" aria-hidden="true" />
                {refreshDetail || 'Refreshing transcript...'}
              </span>
              <span className="font-mono tabular-nums text-[#64748B]">
                {Math.max(8, Math.min(100, Math.round(refreshProgressPct)))}%
              </span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#E2E8F0]">
              <div
                className="h-full rounded-full bg-[#E11D48] transition-all duration-300"
                style={{ width: `${Math.max(8, Math.min(100, refreshProgressPct || 15))}%` }}
              />
            </div>
          </div>
        )}

        {/* Inline Refresh Error Alert */}
        {refreshError && !isRefreshing && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-lg border border-[#FECDD3] bg-[#FFF1F2] px-4 py-2.5 text-xs text-[#881337]"
          >
            <span>{refreshError}</span>
            {onDismissRefreshError && (
              <button
                type="button"
                onClick={onDismissRefreshError}
                aria-label="Dismiss refresh error"
                className="shrink-0 p-1 text-[#881337] hover:text-[#4C0519] cursor-pointer"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Main Split Studio Grid */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
        {/* Left Column: High-Contrast Media Stage + Summary + Chapters + Speakers */}
        <div className="space-y-6 lg:col-span-5 lg:sticky lg:top-22">
          <div className="overflow-hidden rounded-xl border border-[#0F172A] bg-[#0F172A] text-white">
            {job.mediaKind === 'youtube' && job.embedVideoId ? (
              <div className="aspect-video w-full bg-black">
                <iframe
                  ref={iframeRef}
                  src={`https://www.youtube.com/embed/${job.embedVideoId}?enablejsapi=1&rel=0&modestbranding=1`}
                  title={job.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  className="h-full w-full"
                />
              </div>
            ) : job.mediaKind === 'video' && playableSrc ? (
              <div className="aspect-video w-full bg-black">
                <video
                  ref={(el) => {
                    mediaElRef.current = el;
                  }}
                  src={playableSrc}
                  controls
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  className="h-full w-full"
                />
              </div>
            ) : job.mediaKind === 'audio' && playableSrc ? (
              <div className="flex flex-col justify-between gap-4 p-5">
                <div className="flex items-center justify-between text-xs text-slate-300">
                  <span title={job.fileName || job.title} className="truncate font-medium text-white">
                    {truncateTitle(job.fileName || job.title, 50)}
                  </span>
                  <span className="font-mono tabular-nums">
                    {formatDisplayTimestamp(currentTime)} / {formatDisplayTimestamp(job.durationSeconds)}
                  </span>
                </div>
                <audio
                  ref={(el) => {
                    mediaElRef.current = el;
                  }}
                  src={playableSrc}
                  controls
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  className="w-full"
                />
              </div>
            ) : (
              <div className="p-5">
                <p className="text-sm font-medium text-white">Saved transcript snapshot</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-300">
                  Local uploaded media files are kept in browser memory for your active session only. Click any timestamp to highlight cues, or re-upload the file to sync playback.
                </p>
              </div>
            )}

            <div className="flex items-center justify-between border-t border-slate-800 px-4 py-2.5 text-xs text-slate-300">
              <span className="truncate">{job.extractionMethod}</span>
              <span className="shrink-0 font-mono tabular-nums text-white">
                {ytSeekTime !== null && job.mediaKind === 'youtube'
                  ? `Cue ${formatDisplayTimestamp(ytSeekTime)}`
                  : formatDisplayTimestamp(currentTime)}
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-[#E2E8F0] bg-white p-5">
            <h3 className="text-sm font-semibold text-[#0F172A]">Executive Summary</h3>
            <p className="mt-2 text-sm leading-relaxed text-[#475569]">{job.summary}</p>

            {job.chapters.length > 0 && (
              <div className="mt-5 border-t border-[#E2E8F0] pt-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-[#0F172A]">Key Chapters</h3>
                  <span className="font-mono text-xs tabular-nums text-[#64748B]">
                    {job.chapters.length} sections
                  </span>
                </div>
                <ol className="mt-3 divide-y divide-[#F1F5F9]">
                  {job.chapters.map((chapter) => {
                    const isCurrentChapter =
                      currentTime >= chapter.startSeconds && currentTime < chapter.endSeconds;
                    return (
                      <li key={chapter.id} className="py-2.5 first:pt-0 last:pb-0">
                        <button
                          type="button"
                          onClick={() => seekTo(chapter.startSeconds)}
                          className="group flex w-full items-start gap-3 text-left cursor-pointer"
                        >
                          <span
                            className={`mt-0.5 shrink-0 font-mono text-xs tabular-nums transition-colors ${
                              isCurrentChapter
                                ? 'font-semibold text-[#E11D48]'
                                : 'text-[#64748B] group-hover:text-[#E11D48]'
                            }`}
                          >
                            {formatDisplayTimestamp(chapter.startSeconds)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-[#0F172A] transition-colors group-hover:text-[#E11D48]">
                              {chapter.title}
                            </p>
                            {chapter.summary && (
                              <p className="mt-0.5 text-xs leading-relaxed text-[#64748B]">
                                {chapter.summary}
                              </p>
                            )}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}

            <div className="mt-5 border-t border-[#E2E8F0] pt-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[#0F172A]">Speaker Labels</h3>
                <span className="text-xs text-[#64748B]">Rename updates exports</span>
              </div>
              <div className="mt-3 space-y-2">
                {speakerIds.map((speakerId) => {
                  const displayName = getSpeakerDisplayName(job, speakerId);
                  const count = job.segments.filter((s) => s.speakerId === speakerId).length;
                  const isEditing = editingSpeakerId === speakerId;

                  return (
                    <div
                      key={speakerId}
                      className="flex items-center justify-between gap-2 rounded-lg bg-[#F8FAFC] px-3 py-2"
                    >
                      {isEditing ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            commitRename(speakerId);
                          }}
                          className="flex flex-1 items-center gap-2"
                        >
                          <input
                            type="text"
                            value={speakerDraft}
                            onChange={(e) => setSpeakerDraft(e.target.value)}
                            autoFocus
                            className="h-8 flex-1 rounded border border-[#0F172A] bg-white px-2 text-xs text-[#0F172A]"
                          />
                          <button
                            type="submit"
                            className="rounded bg-[#0F172A] px-2.5 py-1 text-xs font-medium text-white cursor-pointer"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingSpeakerId(null)}
                            aria-label="Cancel rename"
                            className="p-1 text-[#64748B] hover:text-[#0F172A] cursor-pointer"
                          >
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </form>
                      ) : (
                        <>
                          <div className="min-w-0">
                            <span className="text-xs font-semibold text-[#0F172A]">
                              {displayName}
                            </span>
                            <span className="ml-2 font-mono text-xs tabular-nums text-[#64748B]">
                              {count} cues
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => beginRename(speakerId)}
                            className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-[#475569] hover:text-[#0F172A] cursor-pointer"
                          >
                            <Edit3 className="h-3 w-3" aria-hidden="true" />
                            Rename
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Searchable Timestamped Transcript Stream */}
        <div className="rounded-xl border border-[#E2E8F0] bg-white lg:col-span-7">
          <div className="flex flex-col gap-3 border-b border-[#E2E8F0] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[#94A3B8]"
                aria-hidden="true"
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search spoken words or speaker..."
                aria-label="Search transcript"
                className="h-10 w-full rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] pl-9 pr-3 text-sm text-[#0F172A] placeholder:text-[#94A3B8] focus:border-[#0F172A] focus:bg-white"
              />
            </div>

            {speakerIds.length > 1 && (
              <div
                role="tablist"
                aria-label="Filter transcript by speaker"
                className="flex items-center gap-1 overflow-x-auto rounded-lg bg-[#F1F5F9] p-1"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selectedSpeaker === 'ALL'}
                  onClick={() => setSelectedSpeaker('ALL')}
                  className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                    selectedSpeaker === 'ALL'
                      ? 'bg-white text-[#0F172A] shadow-xs'
                      : 'text-[#475569] hover:text-[#0F172A]'
                  }`}
                >
                  All
                </button>
                {speakerIds.map((speakerId) => (
                  <button
                    key={speakerId}
                    type="button"
                    role="tab"
                    aria-selected={selectedSpeaker === speakerId}
                    onClick={() => setSelectedSpeaker(speakerId)}
                    className={`max-w-[140px] shrink-0 truncate whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                      selectedSpeaker === speakerId
                        ? 'bg-white text-[#0F172A] shadow-xs'
                        : 'text-[#475569] hover:text-[#0F172A]'
                    }`}
                  >
                    {getSpeakerDisplayName(job, speakerId)}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="max-h-[720px] divide-y divide-[#F1F5F9] overflow-y-auto">
            {filteredSegments.length === 0 ? (
              <div className="px-6 py-14 text-center">
                <p className="text-sm font-medium text-[#0F172A]">
                  No transcript lines match your filter
                </p>
                <p className="mt-1 text-xs text-[#64748B]">
                  Clear the search box or switch back to All speakers to view the full timeline.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setSelectedSpeaker('ALL');
                  }}
                  className="mt-3 rounded-lg border border-[#CBD5E1] px-3 py-1.5 text-xs font-medium text-[#0F172A] hover:border-[#0F172A] cursor-pointer"
                >
                  Reset filters
                </button>
              </div>
            ) : (
              filteredSegments.map((segment) => {
                const isActive = syncedSegmentId === segment.id;
                const speakerName = getSpeakerDisplayName(job, segment.speakerId);

                return (
                  <div
                    key={segment.id}
                    className={`group flex items-start gap-4 px-4 py-3.5 transition-colors duration-150 sm:px-5 ${
                      isActive ? 'bg-[#FFF1F2]/70' : 'hover:bg-[#F8FAFC]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => seekTo(segment.startSeconds, segment.id)}
                      title={`Jump to ${formatDisplayTimestamp(segment.startSeconds)}`}
                      className={`mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 font-mono text-xs tabular-nums transition-colors cursor-pointer ${
                        isActive
                          ? 'bg-[#E11D48] font-medium text-white'
                          : 'bg-[#F1F5F9] text-[#0F172A] group-hover:bg-[#0F172A] group-hover:text-white'
                      }`}
                    >
                      <Play className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
                      {formatDisplayTimestamp(segment.startSeconds)}
                    </button>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-semibold text-[#0F172A]">{speakerName}</span>
                        <span aria-hidden="true" className="text-[#CBD5E1]">
                          ·
                        </span>
                        <span className="inline-flex items-center gap-1 font-mono text-[11px] tabular-nums text-[#64748B]">
                          <Clock className="h-3 w-3" aria-hidden="true" />
                          {formatDisplayTimestamp(segment.startSeconds)}–
                          {formatDisplayTimestamp(segment.endSeconds)}
                        </span>
                      </div>
                      <p className="mt-1 text-[15px] leading-[1.65] text-[#1E293B]">
                        {highlightSearchTerm(segment.text, searchQuery)}
                      </p>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      <ConfirmDeleteModal
        job={pendingDelete ? job : null}
        isDeleting={isDeleting}
        onCancel={() => setPendingDelete(false)}
        onConfirmLocalOnly={() => void handleConfirmDelete(false)}
        onConfirmDeleteDrive={() => void handleConfirmDelete(true)}
      />
    </section>
  );
}

function highlightSearchTerm(text: string, query: string) {
  const trimmed = query.trim();
  if (!trimmed) return text;

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return parts.map((part, idx) =>
    part.toLowerCase() === trimmed.toLowerCase() ? (
      <mark key={idx} className="rounded-xs bg-[#FFE4E6] px-0.5 text-[#9F1239]">
        {part}
      </mark>
    ) : (
      <span key={idx}>{part}</span>
    )
  );
}
