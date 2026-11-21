import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Clock,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  Play,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { TranscriptJob } from '../types/transcript';
import {
  formatDisplayTimestamp,
  getSpeakerDisplayName,
  serializeToJSON,
  serializeToSRT,
  serializeToTXT,
  serializeToVTT,
  slugifyFilename,
  triggerFileDownload,
} from '../utils/exporters';

interface StudioWorkspaceProps {
  job: TranscriptJob;
  onRenameSpeaker: (speakerId: string, newName: string) => void;
  onDeleteJob: (jobId: string) => void;
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
}: StudioWorkspaceProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSpeaker, setSelectedSpeaker] = useState<string>('ALL');
  const [currentTime, setCurrentTime] = useState(0);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [editingSpeakerId, setEditingSpeakerId] = useState<string | null>(null);
  const [speakerDraft, setSpeakerDraft] = useState('');
  const [copiedState, setCopiedState] = useState<string | null>(null);
  const [ytSeekTime, setYtSeekTime] = useState<number | null>(null);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const mediaElRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

  useEffect(() => {
    setSearchQuery('');
    setSelectedSpeaker('ALL');
    setCurrentTime(0);
    setActiveSegmentId(null);
    setEditingSpeakerId(null);
    setYtSeekTime(null);
  }, [job.id]);

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

  const playableSrc = job.localMediaUrl || job.remoteMediaUrl;

  return (
    <section aria-label="Transcript studio workbench" className="space-y-6">
      {/* Job Title & Unboxed Metadata Strip */}
      <div className="flex flex-col gap-4 border-b border-[#E2E8F0] pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-[#0F172A] sm:text-2xl">
            {job.title}
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

        {/* Export Controls */}
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
            onClick={() => onDeleteJob(job.id)}
            aria-label="Delete transcript from history"
            title="Remove transcript"
            className="inline-flex items-center justify-center rounded-lg border border-[#E2E8F0] bg-white p-2 text-[#64748B] transition-colors hover:border-[#FECDD3] hover:text-[#BE123C] cursor-pointer"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
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
                  <span className="truncate font-medium text-white">
                    {job.fileName || job.title}
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
