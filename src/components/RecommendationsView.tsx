import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FileSpreadsheet,
  HardDrive,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react';
import type { AskAiContext } from '../types/askAi';
import type {
  RecommendationEntry,
  RecommendationPollResponse,
  RecommendationSnapshot,
  TranscriptJob,
} from '../types/transcript';
import {
  buildLatestRecommendationsAskAiContext,
  buildSelectedAnalysesAskAiContext,
} from '../utils/askAiContexts';
import {
  formatLocalRecommendationTimestamp,
  getSourceShortLabel,
  sanitizeRecommendationDownloadName,
  serializeRecommendationsToCSV,
  slugifyFilename,
  triggerFileDownload,
  truncateTitle,
} from '../utils/exporters';

interface RecommendationsViewProps {
  jobs: TranscriptJob[];
  latestRecommendation: RecommendationSnapshot | null;
  isLoadingLatest: boolean;
  driveEnabled: boolean;
  driveNeedsBridgeUpdate: boolean;
  buildDriveHeaders: () => Record<string, string>;
  onRecommendationGenerated: (snapshot: RecommendationSnapshot) => void;
  onSyncRecommendationToDrive: (snapshot: RecommendationSnapshot) => Promise<{
    ok: boolean;
    needsBridgeUpdate?: boolean;
    error?: string;
  }>;
  onRefreshLatestFromDrive: () => Promise<void>;
  onOpenDriveSetup: () => void;
  onGoToAnalysis: () => void;
  onOpenAskAi: (context: AskAiContext) => void;
}

type AtfFilter = 'all' | 'atf' | 'outside';

function matchesFilter(entry: RecommendationEntry, query: string, atfFilter: AtfFilter): boolean {
  if (atfFilter === 'atf' && !entry.atfNumber) return false;
  if (atfFilter === 'outside' && entry.atfNumber) return false;

  if (!query) return true;
  const q = query.toLowerCase();
  if (entry.stock.toLowerCase().includes(q)) return true;
  if (entry.atfNumber && entry.atfNumber.toLowerCase().includes(q)) return true;
  if (entry.entryAndDipLevels.toLowerCase().includes(q)) return true;
  if (entry.targetsAndStopLoss.toLowerCase().includes(q)) return true;
  if (entry.horizonAndGuidance.toLowerCase().includes(q)) return true;
  return entry.sources.some(
    (s) =>
      s.videoTitle.toLowerCase().includes(q) ||
      s.sourceFileName.toLowerCase().includes(q) ||
      (s.specificNotes && s.specificNotes.toLowerCase().includes(q)) ||
      s.timestamps.some((t) => t.toLowerCase().includes(q))
  );
}

function RecommendationTable({
  title,
  subtitle,
  entries,
  totalCount,
  accentClass,
  emptyFilteredMessage,
}: {
  title: string;
  subtitle: string;
  entries: RecommendationEntry[];
  totalCount: number;
  accentClass: string;
  emptyFilteredMessage: string;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h3 className={`text-base font-semibold tracking-tight ${accentClass}`}>
            {title}
          </h3>
          <span className="text-xs text-[#64748B]">{subtitle}</span>
        </div>
        <span className="font-mono text-xs tabular-nums text-[#64748B]">
          {entries.length === totalCount
            ? `${totalCount} ${totalCount === 1 ? 'stock' : 'stocks'}`
            : `${entries.length} of ${totalCount} shown`}
        </span>
      </div>

      {entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#CBD5E1] bg-[#F8FAFC] px-4 py-6 text-center text-xs text-[#64748B]">
          {totalCount === 0
            ? `No ${title.toLowerCase()} were identified in the selected analysis.md files.`
            : emptyFilteredMessage}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[#E2E8F0] bg-white">
          <table className="w-full min-w-[820px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                <th className="w-[76px] whitespace-nowrap px-3.5 py-2.5 text-xs font-semibold text-[#475569]">
                  ATF #
                </th>
                <th className="w-[170px] px-3.5 py-2.5 text-xs font-semibold text-[#475569]">
                  Stock
                </th>
                <th className="w-[165px] px-3.5 py-2.5 text-xs font-semibold text-[#475569]">
                  Entry / Dip Levels
                </th>
                <th className="w-[165px] px-3.5 py-2.5 text-xs font-semibold text-[#475569]">
                  Targets &amp; SL
                </th>
                <th className="px-3.5 py-2.5 text-xs font-semibold text-[#475569]">
                  Horizon &amp; Buying Plan
                </th>
                <th className="w-[240px] px-3.5 py-2.5 text-xs font-semibold text-[#475569]">
                  Sources &amp; Timestamps
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {entries.map((entry, idx) => (
                <tr
                  key={`${entry.category}_${entry.stock}_${idx}`}
                  className="transition-colors duration-150 hover:bg-[#F8FAFC]"
                >
                  <td className="align-top whitespace-nowrap px-3.5 py-3 font-mono text-xs tabular-nums text-[#334155]">
                    {entry.atfNumber || '—'}
                  </td>

                  <td className="align-top px-3.5 py-3">
                    <div className="font-semibold text-[#0F172A]">{entry.stock}</div>
                    {entry.hasLevelConflict && (
                      <div className="mt-1 flex items-center gap-1 text-[11px] font-medium text-[#B45309]">
                        <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                        <span>Conflicting levels</span>
                      </div>
                    )}
                    {entry.sources.length > 1 && (
                      <div className="mt-0.5 font-mono text-[11px] tabular-nums text-[#64748B]">
                        {entry.sources.length} videos
                      </div>
                    )}
                  </td>

                  <td className="align-top px-3.5 py-3 font-mono text-xs leading-relaxed tabular-nums text-[#0F172A]">
                    {entry.entryAndDipLevels}
                  </td>

                  <td className="align-top px-3.5 py-3 font-mono text-xs leading-relaxed tabular-nums text-[#0F172A]">
                    {entry.targetsAndStopLoss}
                  </td>

                  <td className="align-top px-3.5 py-3 text-xs leading-relaxed text-[#334155]">
                    {entry.horizonAndGuidance}
                  </td>

                  <td className="align-top px-3.5 py-3">
                    <ul className="space-y-2">
                      {entry.sources.map((src, sIdx) => (
                        <li
                          key={`${src.sourceFileName}_${sIdx}`}
                          className={sIdx > 0 ? 'border-t border-[#F1F5F9] pt-2' : ''}
                        >
                          <div className="text-xs font-medium text-[#0F172A]" title={src.videoTitle}>
                            {truncateTitle(src.videoTitle, 44)}
                          </div>
                          {src.timestamps.length > 0 && (
                            <div className="mt-0.5 font-mono text-[11px] tabular-nums text-[#64748B]">
                              {src.timestamps.join(' · ')}
                            </div>
                          )}
                          {src.specificNotes && (
                            <p className="mt-0.5 text-[11px] leading-snug text-[#475569]">
                              {src.specificNotes}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function RecommendationsView({
  jobs,
  latestRecommendation,
  isLoadingLatest,
  driveEnabled,
  driveNeedsBridgeUpdate,
  buildDriveHeaders,
  onRecommendationGenerated,
  onSyncRecommendationToDrive,
  onRefreshLatestFromDrive,
  onOpenDriveSetup,
  onGoToAnalysis,
  onOpenAskAi,
}: RecommendationsViewProps) {
  const analyzedJobs = useMemo(
    () => jobs.filter((j) => Boolean(j.analysis?.markdown?.trim())),
    [jobs]
  );

  const [selectedJobIds, setSelectedJobIds] = useState<string[]>(() =>
    analyzedJobs.map((j) => j.id)
  );
  const knownAnalyzedIdsRef = useRef<Set<string>>(new Set(analyzedJobs.map((j) => j.id)));

  // Auto-select newly analyzed videos as they arrive without overriding manual unchecks
  useEffect(() => {
    const currentAnalyzedIds = new Set(analyzedJobs.map((j) => j.id));
    const newlyDiscovered = analyzedJobs
      .filter((j) => !knownAnalyzedIdsRef.current.has(j.id))
      .map((j) => j.id);

    knownAnalyzedIdsRef.current = currentAnalyzedIds;

    setSelectedJobIds((prev) => {
      const stillValid = prev.filter((id) => currentAnalyzedIds.has(id));
      if (newlyDiscovered.length === 0 && stillValid.length === prev.length) {
        return prev;
      }
      const next = Array.from(new Set([...stillValid, ...newlyDiscovered]));
      return next;
    });
  }, [analyzedJobs]);

  const [isGenerating, setIsGenerating] = useState(false);
  const [stageLabel, setStageLabel] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSyncingToDrive, setIsSyncingToDrive] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [atfFilter, setAtfFilter] = useState<AtfFilter>('all');
  const [displayMode, setDisplayMode] = useState<'tables' | 'markdown'>('tables');
  const [copied, setCopied] = useState(false);
  const [showSourcesList, setShowSourcesList] = useState(false);
  const [isSourcesExpanded, setIsSourcesExpanded] = useState(false);

  const pollCancelledRef = useRef(false);

  useEffect(() => {
    return () => {
      pollCancelledRef.current = true;
    };
  }, []);

  const selectedJobs = useMemo(
    () => analyzedJobs.filter((j) => selectedJobIds.includes(j.id)),
    [analyzedJobs, selectedJobIds]
  );

  const unanalyzedCount = Math.max(0, jobs.length - analyzedJobs.length);

  function toggleJobSelection(jobId: string) {
    setSelectedJobIds((prev) =>
      prev.includes(jobId) ? prev.filter((id) => id !== jobId) : [...prev, jobId]
    );
  }

  async function handleGenerateRecommendations() {
    if (isGenerating || selectedJobs.length === 0) return;

    setIsGenerating(true);
    setErrorMessage(null);
    setSyncError(null);
    setStageLabel(
      `Packaging ${selectedJobs.length} analysis.md ${selectedJobs.length === 1 ? 'file' : 'files'}...`
    );
    pollCancelledRef.current = false;

    try {
      const formData = new FormData();
      const manifest: Array<{
        jobId: string;
        sourceKey?: string;
        title: string;
        folderName?: string;
        fileName: string;
      }> = [];
      const usedFileNames = new Set<string>();

      for (let idx = 0; idx < selectedJobs.length; idx += 1) {
        const job = selectedJobs[idx];
        const md = job.analysis?.markdown?.trim();
        if (!md) continue;
        const displayTitle = job.driveFolderName?.trim() || truncateTitle(job.title, 60);
        const shortLabel = getSourceShortLabel(job.sourceType);
        const baseSlug = slugifyFilename(job.driveFolderName || `${shortLabel}-${job.title}`);
        let fileName = `${baseSlug}-analysis.md`;
        if (usedFileNames.has(fileName.toLowerCase())) {
          fileName = `${baseSlug}-${idx + 1}-analysis.md`;
        }
        usedFileNames.add(fileName.toLowerCase());

        const file = new File([md], fileName, { type: 'text/markdown' });
        formData.append('analysisFiles', file);
        manifest.push({
          jobId: job.id,
          sourceKey: job.sourceKey,
          title: displayTitle,
          folderName: job.driveFolderName,
          fileName,
        });
      }

      formData.append('manifest', JSON.stringify(manifest));
      formData.append('clientTimestamp', formatLocalRecommendationTimestamp(new Date()));

      const startRes = await fetch('/api/recommendations/generate', {
        method: 'POST',
        headers: buildDriveHeaders(),
        body: formData,
      });

      const startPayload = (await startRes.json()) as
        | { ok: true; recommendationJobId: string; status: 'processing' }
        | { ok: false; message?: string };

      if (!startRes.ok || !startPayload.ok) {
        setErrorMessage(
          'message' in startPayload && startPayload.message
            ? startPayload.message
            : 'Failed to start recommendation synthesis.'
        );
        return;
      }

      const { recommendationJobId } = startPayload;
      while (!pollCancelledRef.current) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (pollCancelledRef.current) return;

        const pollRes = await fetch(
          `/api/recommendations/jobs/${encodeURIComponent(recommendationJobId)}`
        );
        if (!pollRes.ok) {
          setErrorMessage('Lost track of recommendation job. Please try again.');
          return;
        }

        const pollData = (await pollRes.json()) as RecommendationPollResponse;
        setStageLabel(pollData.stageLabel);

        if (pollData.status === 'completed' && pollData.recommendation) {
          onRecommendationGenerated(pollData.recommendation);
          setDisplayMode('tables');
          return;
        }

        if (pollData.status === 'failed') {
          setErrorMessage(pollData.error || 'Failed to generate recommendations.');
          return;
        }
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? `Network error contacting recommendations server: ${err.message}`
          : 'Could not reach recommendations server.'
      );
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleManualSyncToDrive() {
    if (!latestRecommendation || isSyncingToDrive) return;
    setIsSyncingToDrive(true);
    setSyncError(null);
    try {
      const res = await onSyncRecommendationToDrive(latestRecommendation);
      if (!res.ok) {
        setSyncError(res.error || 'Could not save recommendations to Google Drive.');
      }
    } finally {
      setIsSyncingToDrive(false);
    }
  }

  async function handleCopyMarkdown(markdown: string) {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable
    }
  }

  const trimmedQuery = searchQuery.trim();
  const filteredStrongBuys = useMemo(() => {
    if (!latestRecommendation) return [];
    return latestRecommendation.strongBuys.filter((e) =>
      matchesFilter(e, trimmedQuery, atfFilter)
    );
  }, [latestRecommendation, trimmedQuery, atfFilter]);

  const filteredSwingTrades = useMemo(() => {
    if (!latestRecommendation) return [];
    return latestRecommendation.swingTrades.filter((e) =>
      matchesFilter(e, trimmedQuery, atfFilter)
    );
  }, [latestRecommendation, trimmedQuery, atfFilter]);

  const isMarkdownOnlySnapshot = Boolean(
    latestRecommendation &&
      latestRecommendation.strongBuys.length === 0 &&
      latestRecommendation.swingTrades.length === 0 &&
      latestRecommendation.markdown.trim()
  );

  const showBridgeWarning = Boolean(
    driveNeedsBridgeUpdate ||
      latestRecommendation?.driveSyncWarning ||
      syncError
  );

  return (
    <div className="space-y-6">
      {/* Top Workspace Header */}
      <section className="rounded-xl border border-[#E2E8F0] bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight text-[#0F172A] sm:text-2xl">
              Recommendations
            </h1>
            <p className="mt-1 text-sm text-[#475569]">
              Consolidates per-video <span className="font-mono text-xs text-[#0F172A]">analysis.md</span> files into Strong Buys and Swing Trades with exact levels and source attribution. Shows the latest run while archiving every snapshot to Drive.
            </p>
          </div>

          <div className="flex shrink-0 flex-nowrap items-center gap-2">
            {driveEnabled && (
              <button
                type="button"
                title="Sync latest from Drive"
                aria-label="Sync latest from Drive"
                onClick={() => void onRefreshLatestFromDrive()}
                disabled={isLoadingLatest || isGenerating}
                className="inline-flex shrink-0 items-center justify-center rounded-lg border border-[#E2E8F0] bg-white p-2 text-[#334155] transition-colors hover:border-[#94A3B8] hover:text-[#0F172A] disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${isLoadingLatest ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
              </button>
            )}
            <button
              type="button"
              disabled={isGenerating || selectedJobs.length === 0}
              onClick={() => void handleGenerateRecommendations()}
              className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#BE123C] disabled:cursor-not-allowed disabled:bg-[#CBD5E1] disabled:text-[#64748B] cursor-pointer"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  Generating...
                </>
              ) : (
                <>
                  <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
                  Get Recommendations ({selectedJobs.length})
                </>
              )}
            </button>
          </div>
        </div>
      </section>

      {/* Collapsible Analyzed Sources Bar (collapsed by default to maximize table space) */}
      <section className="rounded-xl border border-[#E2E8F0] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
          <button
            type="button"
            aria-expanded={isSourcesExpanded}
            aria-controls="analyzed-sources-panel"
            onClick={() => setIsSourcesExpanded((v) => !v)}
            className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1 text-left cursor-pointer"
          >
            <span className="text-sm font-semibold text-[#0F172A]">Analyzed Sources</span>
            <span className="text-xs text-[#64748B]">
              <span className="font-mono font-medium tabular-nums text-[#0F172A]">
                {selectedJobs.length}
              </span>{' '}
              of{' '}
              <span className="font-mono tabular-nums text-[#0F172A]">{analyzedJobs.length}</span>{' '}
              selected
              {unanalyzedCount > 0 && (
                <>
                  {' '}
                  · <span className="font-mono tabular-nums">{unanalyzedCount}</span> without{' '}
                  <span className="font-mono">analysis.md</span> skipped
                </>
              )}
            </span>
          </button>

          <div className="flex shrink-0 flex-wrap items-center gap-2.5">
            {isSourcesExpanded && analyzedJobs.length > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setSelectedJobIds(analyzedJobs.map((j) => j.id))}
                  className="font-medium text-[#0F172A] hover:text-[#E11D48] cursor-pointer"
                >
                  All
                </button>
                <span className="text-[#CBD5E1]" aria-hidden="true">
                  /
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedJobIds([])}
                  className="font-medium text-[#64748B] hover:text-[#0F172A] cursor-pointer"
                >
                  Clear
                </button>
              </div>
            )}

            <button
              type="button"
              disabled={selectedJobs.length === 0}
              onClick={() => {
                const ctx = buildSelectedAnalysesAskAiContext(selectedJobs);
                if (ctx) onOpenAskAi(ctx);
              }}
              title={
                selectedJobs.length === 0
                  ? 'Select at least one analyzed source file to ask AI'
                  : `Chat with ${selectedJobs.length} selected analyzed ${selectedJobs.length === 1 ? 'file' : 'files'}`
              }
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-[#0F172A] px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-[#1E293B] disabled:cursor-not-allowed disabled:bg-[#CBD5E1] disabled:text-[#64748B] cursor-pointer"
            >
              <Bot className="h-3.5 w-3.5" aria-hidden="true" />
              Ask AI{selectedJobs.length > 0 ? ` (${selectedJobs.length})` : ''}
            </button>

            <button
              type="button"
              aria-expanded={isSourcesExpanded}
              aria-controls="analyzed-sources-panel"
              onClick={() => setIsSourcesExpanded((v) => !v)}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-1 text-xs font-medium text-[#334155] transition-colors hover:border-[#94A3B8] hover:text-[#0F172A] cursor-pointer"
            >
              {isSourcesExpanded ? (
                <>
                  Hide
                  <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                </>
              ) : (
                <>
                  Select files
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                </>
              )}
            </button>
          </div>
        </div>

        {isSourcesExpanded && (
          <div id="analyzed-sources-panel" className="border-t border-[#E2E8F0] px-5 py-4">
            {analyzedJobs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[#CBD5E1] bg-[#F8FAFC] p-5 text-center">
                <Sparkles className="mx-auto h-5 w-5 text-[#475569]" aria-hidden="true" />
                <p className="mt-2.5 text-xs font-medium text-[#0F172A]">
                  No analysis.md files available yet
                </p>
                <p className="mt-1 text-xs leading-relaxed text-[#64748B]">
                  Run Gen AI Analysis on one or more transcribed videos first. Only analyzed videos are sent for recommendations.
                </p>
                <button
                  type="button"
                  onClick={onGoToAnalysis}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[#0F172A] px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-[#1E293B] cursor-pointer"
                >
                  Open Gen AI Analysis
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <div className="grid max-h-[320px] grid-cols-1 gap-2.5 overflow-y-auto pr-0.5 sm:grid-cols-2 lg:grid-cols-3">
                {analyzedJobs.map((job) => {
                  const checked = selectedJobIds.includes(job.id);
                  const sourceLabel = job.driveFolderName?.trim() || truncateTitle(job.title, 48);
                  return (
                    <label
                      key={job.id}
                      title={job.driveFolderName || job.title}
                      className={`flex items-start gap-2.5 rounded-lg border p-2.5 transition-colors cursor-pointer ${
                        checked
                          ? 'border-[#0F172A] bg-[#F8FAFC]'
                          : 'border-[#E2E8F0] bg-white hover:border-[#94A3B8]'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleJobSelection(job.id)}
                        disabled={isGenerating}
                        className="mt-0.5 h-4 w-4 shrink-0 rounded border-[#CBD5E1] accent-[#0F172A] cursor-pointer"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-[#0F172A]">
                          {truncateTitle(sourceLabel, 48)}
                        </p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-[#64748B]">
                          <span>{getSourceShortLabel(job.sourceType)}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">analysis.md</span>
                          {job.driveTranscriptFileIds?.analysisMdId && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="inline-flex items-center gap-1 text-[#15803D]">
                                <HardDrive className="h-2.5 w-2.5" aria-hidden="true" />
                                Drive
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Full-Width Latest Recommendations Viewport */}
      <section className="rounded-xl border border-[#E2E8F0] bg-white p-5 sm:p-6">
            {/* Bridge update or sync warning (non-blocking) */}
            {showBridgeWarning && (
              <div
                role="status"
                className="mb-5 flex flex-col gap-3 rounded-lg border border-[#FDE68A] bg-[#FFFBEB] p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#B45309]" aria-hidden="true" />
                  <p className="text-xs leading-relaxed text-[#78350F]">
                    {syncError ||
                      latestRecommendation?.driveSyncWarning ||
                      'Update your Apps Script Code.gs from Drive Setup (Deploy -> New Version) so CueScript can archive and load CueScript/Recommendations/ files.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onOpenDriveSetup}
                  className="shrink-0 whitespace-nowrap rounded-lg bg-[#0F172A] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#1E293B] cursor-pointer"
                >
                  Open Drive Setup
                </button>
              </div>
            )}

            {/* Error Banner */}
            {errorMessage && (
              <div
                role="alert"
                className="mb-5 flex items-start gap-3 rounded-lg border border-[#FECDD3] bg-[#FFF1F2] p-4"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#BE123C]" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-[#881337]">{errorMessage}</p>
                </div>
              </div>
            )}

            {/* Active Generation Banner */}
            {isGenerating && (
              <div
                role="status"
                aria-live="polite"
                className="mb-5 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-5"
              >
                <div className="flex items-center gap-3">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#E11D48]" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-medium text-[#0F172A]">
                      {stageLabel || 'Generating consolidated stock recommendations...'}
                    </p>
                    <p className="mt-0.5 text-xs text-[#64748B]">
                      Sending {selectedJobs.length} attached analysis.md{' '}
                      {selectedJobs.length === 1 ? 'file' : 'files'} (OpenAI primary, Google Gemini fallback) and archiving to Drive.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Initial Drive Loading Skeleton */}
            {isLoadingLatest && !latestRecommendation && !isGenerating ? (
              <div className="space-y-4 py-2" aria-busy="true" aria-label="Loading latest recommendations">
                <div className="h-5 w-56 animate-pulse rounded bg-[#F1F5F9]" />
                <div className="h-14 w-full animate-pulse rounded-lg bg-[#F8FAFC]" />
                <div className="space-y-2 pt-2">
                  <div className="h-9 w-full animate-pulse rounded bg-[#F1F5F9]" />
                  <div className="h-10 w-full animate-pulse rounded bg-[#F8FAFC]" />
                  <div className="h-10 w-full animate-pulse rounded bg-[#F8FAFC]" />
                  <div className="h-10 w-full animate-pulse rounded bg-[#F8FAFC]" />
                </div>
              </div>
            ) : !latestRecommendation ? (
              /* Empty State */
              <div className="rounded-lg border border-dashed border-[#CBD5E1] bg-[#F8FAFC] px-6 py-12 text-center">
                <TrendingUp className="mx-auto h-7 w-7 text-[#475569]" aria-hidden="true" />
                <h2 className="mt-3 text-base font-semibold tracking-tight text-[#0F172A]">
                  No recommendations generated yet
                </h2>
                <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-[#64748B]">
                  {analyzedJobs.length > 0
                    ? `${analyzedJobs.length} analyzed ${analyzedJobs.length === 1 ? 'video is' : 'videos are'} ready. Click Get Recommendations to synthesize Strong Buys and Swing Trades with levels and source timestamps.`
                    : 'Run Gen AI Analysis on your transcribed videos first so their analysis.md files can be synthesized here.'}
                </p>
                {analyzedJobs.length > 0 ? (
                  <button
                    type="button"
                    disabled={isGenerating || selectedJobs.length === 0}
                    onClick={() => void handleGenerateRecommendations()}
                    className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#BE123C] disabled:bg-[#CBD5E1] disabled:text-[#64748B] cursor-pointer"
                  >
                    <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
                    Get Recommendations ({selectedJobs.length})
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={onGoToAnalysis}
                    className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[#0F172A] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#1E293B] cursor-pointer"
                  >
                    Go to Gen AI Analysis
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            ) : (
              /* Populated Latest Recommendations View */
              <div className="space-y-6">
                {/* Latest Snapshot Metadata Header (Zero-Pill unboxed text with separators) */}
                <div className="border-b border-[#E2E8F0] pb-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-lg font-semibold tracking-tight text-[#0F172A]">
                      Latest Recommendations
                    </h2>
                    <span className="font-mono text-xs tabular-nums text-[#475569]">
                      {latestRecommendation.formattedTimestamp}
                    </span>
                  </div>

                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#64748B]">
                    <span>
                      <span className="font-mono tabular-nums text-[#0F172A]">
                        {latestRecommendation.strongBuys.length}
                      </span>{' '}
                      Strong Buys
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      <span className="font-mono tabular-nums text-[#0F172A]">
                        {latestRecommendation.swingTrades.length}
                      </span>{' '}
                      Swing Trades
                    </span>
                    {latestRecommendation.sourceVideos.length > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <button
                          type="button"
                          onClick={() => setShowSourcesList((v) => !v)}
                          className="font-medium text-[#334155] underline underline-offset-4 hover:text-[#0F172A] cursor-pointer"
                        >
                          {latestRecommendation.sourceVideos.length}{' '}
                          {latestRecommendation.sourceVideos.length === 1 ? 'source file' : 'source files'}
                        </button>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>
                      Engine: <span className="text-[#334155]">{latestRecommendation.engineUsed}</span>
                    </span>
                    {latestRecommendation.syncedToDrive ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span
                          title={`CueScript/Recommendations/${latestRecommendation.driveFiles?.mdFileName || `${latestRecommendation.fileBaseName}.md`}`}
                          className="inline-flex items-center gap-1 font-medium text-[#15803D]"
                        >
                          <HardDrive className="h-3 w-3" aria-hidden="true" />
                          Archived in Drive
                        </span>
                      </>
                    ) : driveEnabled ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <button
                          type="button"
                          disabled={isSyncingToDrive}
                          onClick={() => void handleManualSyncToDrive()}
                          className="inline-flex items-center gap-1 font-medium text-[#0F172A] underline underline-offset-4 hover:text-[#E11D48] disabled:opacity-50 cursor-pointer"
                        >
                          {isSyncingToDrive ? (
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                          ) : (
                            <HardDrive className="h-3 w-3" aria-hidden="true" />
                          )}
                          Save to Drive
                        </button>
                      </>
                    ) : null}
                  </div>

                  {/* Expandable Source Files Audit List */}
                  {showSourcesList && latestRecommendation.sourceVideos.length > 0 && (
                    <div className="mt-3 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 py-2.5 text-xs text-[#334155]">
                      <p className="font-medium text-[#0F172A]">
                        Included analysis.md files ({latestRecommendation.sourceVideos.length}):
                      </p>
                      <ul className="mt-1.5 space-y-1">
                        {latestRecommendation.sourceVideos.map((src, i) => (
                          <li key={`${src.fileName}_${i}`} className="flex flex-wrap items-baseline gap-x-2">
                            <span className="font-mono text-[11px] tabular-nums text-[#64748B]">
                              {String(i + 1).padStart(2, '0')}.
                            </span>
                            <span className="font-medium text-[#0F172A]">{src.title}</span>
                            <span className="font-mono text-[11px] text-[#64748B]">
                              {src.folderName ? `${src.folderName}/analysis.md` : src.fileName}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Executive Summary */}
                {latestRecommendation.executiveSummary && (
                  <p className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3 text-sm leading-relaxed text-[#334155]">
                    {latestRecommendation.executiveSummary}
                  </p>
                )}

                {/* Filter, Search, Display Mode & Export Toolbar */}
                <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                  <div className="flex flex-wrap items-center gap-2.5">
                    {!isMarkdownOnlySnapshot && displayMode === 'tables' && (
                      <>
                        <div className="relative min-w-[220px] flex-1 sm:flex-initial">
                          <Search
                            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#64748B]"
                            aria-hidden="true"
                          />
                          <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Filter stock, level, or video..."
                            aria-label="Filter recommendations"
                            className="w-full rounded-lg border border-[#E2E8F0] bg-white py-1.5 pl-8 pr-7 text-xs text-[#0F172A] placeholder:text-[#94A3B8] focus:border-[#0F172A] focus:outline-none"
                          />
                          {searchQuery && (
                            <button
                              type="button"
                              aria-label="Clear search"
                              onClick={() => setSearchQuery('')}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-[#64748B] hover:text-[#0F172A] cursor-pointer"
                            >
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          )}
                        </div>

                        <div
                          role="group"
                          aria-label="Filter by ATF membership"
                          className="inline-flex items-center gap-1 rounded-lg bg-[#F1F5F9] p-1"
                        >
                          {(
                            [
                              { id: 'all', label: 'All' },
                              { id: 'atf', label: 'ATF Top 60' },
                              { id: 'outside', label: 'Outside ATF' },
                            ] as const
                          ).map((opt) => (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => setAtfFilter(opt.id)}
                              className={`whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
                                atfFilter === opt.id
                                  ? 'bg-white text-[#0F172A] shadow-xs'
                                  : 'text-[#475569] hover:text-[#0F172A]'
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </>
                    )}

                    {!isMarkdownOnlySnapshot && (
                      <div
                        role="tablist"
                        aria-label="Recommendations view format"
                        className="inline-flex items-center gap-1 rounded-lg bg-[#F1F5F9] p-1"
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={displayMode === 'tables'}
                          onClick={() => setDisplayMode('tables')}
                          className={`whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
                            displayMode === 'tables'
                              ? 'bg-white text-[#0F172A] shadow-xs'
                              : 'text-[#475569] hover:text-[#0F172A]'
                          }`}
                        >
                          Tables
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={displayMode === 'markdown'}
                          onClick={() => setDisplayMode('markdown')}
                          className={`whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
                            displayMode === 'markdown'
                              ? 'bg-white text-[#0F172A] shadow-xs'
                              : 'text-[#475569] hover:text-[#0F172A]'
                          }`}
                        >
                          Raw Markdown
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Export Actions */}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleCopyMarkdown(latestRecommendation.markdown)}
                      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs font-medium text-[#334155] transition-colors hover:border-[#94A3B8] hover:text-[#0F172A] cursor-pointer"
                    >
                      {copied ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-[#15803D]" aria-hidden="true" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                          Copy MD
                        </>
                      )}
                    </button>

                    {!isMarkdownOnlySnapshot && (
                      <button
                        type="button"
                        onClick={() =>
                          triggerFileDownload(
                            serializeRecommendationsToCSV(latestRecommendation),
                            sanitizeRecommendationDownloadName(
                              latestRecommendation.fileBaseName,
                              'csv'
                            ),
                            'text/csv;charset=utf-8'
                          )
                        }
                        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs font-medium text-[#334155] transition-colors hover:border-[#94A3B8] hover:text-[#0F172A] cursor-pointer"
                      >
                        <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />
                        CSV
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() =>
                        triggerFileDownload(
                          latestRecommendation.markdown,
                          sanitizeRecommendationDownloadName(
                            latestRecommendation.fileBaseName,
                            'md'
                          ),
                          'text/markdown;charset=utf-8'
                        )
                      }
                      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-[#0F172A] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#1E293B] cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      Download .md
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        onOpenAskAi(buildLatestRecommendationsAskAiContext(latestRecommendation))
                      }
                      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-[#E11D48] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#BE123C] cursor-pointer"
                    >
                      <Bot className="h-3.5 w-3.5" aria-hidden="true" />
                      Chat with recommendations
                    </button>
                  </div>
                </div>

                {/* Data Tables or Raw Markdown */}
                {displayMode === 'tables' && !isMarkdownOnlySnapshot ? (
                  <div className="space-y-8">
                    <RecommendationTable
                      title="Strong Buys"
                      subtitle="High-conviction accumulation & core portfolio calls"
                      entries={filteredStrongBuys}
                      totalCount={latestRecommendation.strongBuys.length}
                      accentClass="text-[#0F172A]"
                      emptyFilteredMessage="No Strong Buy entries match the active search or ATF filter."
                    />

                    <RecommendationTable
                      title="Swing Trades"
                      subtitle="Short-to-medium-term tactical & target-driven setups"
                      entries={filteredSwingTrades}
                      totalCount={latestRecommendation.swingTrades.length}
                      accentClass="text-[#0F172A]"
                      emptyFilteredMessage="No Swing Trade entries match the active search or ATF filter."
                    />
                  </div>
                ) : (
                  <pre className="overflow-x-auto rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-[#0F172A]">
                    {latestRecommendation.markdown}
                  </pre>
                )}

                {/* Drive Archive Filename Footnote */}
                <div className="border-t border-[#F1F5F9] pt-3 text-[11px] text-[#64748B]">
                  Archive filename:{' '}
                  <span className="font-mono text-[#334155]">
                    CueScript/Recommendations/{latestRecommendation.fileBaseName}.md
                  </span>{' '}
                  &amp;{' '}
                  <span className="font-mono text-[#334155]">.json</span>
                </div>
              </div>
            )}
      </section>
    </div>
  );
}
