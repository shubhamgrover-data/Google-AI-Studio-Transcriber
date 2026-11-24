import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Copy,
  Download,
  FileText,
  HardDrive,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Sparkles,
  Upload,
} from 'lucide-react';
import type {
  AnalysisPollResponse,
  TranscriptAnalysisResult,
  TranscriptJob,
} from '../types/transcript';
import {
  formatDisplayTimestamp,
  serializeToTXT,
  slugifyFilename,
  triggerFileDownload,
  truncateTitle,
} from '../utils/exporters';

interface GenAiAnalysisViewProps {
  jobs: TranscriptJob[];
  initialSelectedJobId?: string | null;
  onSaveAnalysis: (jobId: string, analysis: TranscriptAnalysisResult) => Promise<boolean> | void;
  onSyncJobToDrive?: (jobId: string) => Promise<boolean>;
  driveEnabled?: boolean;
  onGoToStudio: () => void;
}

interface ReferenceStatus {
  loading: boolean;
  available: boolean;
  fileName?: string;
  publicUrl?: string;
}

type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'list'; items: string[] }
  | { type: 'paragraph'; text: string };

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  const cells = splitTableRow(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      i += 1;
      continue;
    }

    if (
      trimmed.includes('|') &&
      i + 1 < lines.length &&
      isTableSeparatorLine(lines[i + 1])
    ) {
      const headers = splitTableRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length) {
        const rowLine = lines[i].trim();
        if (!rowLine || !rowLine.includes('|')) break;
        if (isTableSeparatorLine(rowLine)) {
          i += 1;
          continue;
        }
        rows.push(splitTableRow(rowLine));
        i += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i].trim();
      if (
        !cur ||
        /^#{1,4}\s+/.test(cur) ||
        /^[-*]\s+/.test(cur) ||
        (cur.includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1]))
      ) {
        break;
      }
      paraLines.push(cur);
      i += 1;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', text: paraLines.join(' ') });
    }
  }

  return blocks;
}

function renderInlineFormatting(text: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      tokens.push(
        <strong key={`b_${keyIdx++}`} className="font-semibold text-[#0F172A]">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      tokens.push(
        <em key={`i_${keyIdx++}`} className="italic text-[#334155]">
          {token.slice(1, -1)}
        </em>
      );
    } else if (token.startsWith('`') && token.endsWith('`')) {
      tokens.push(
        <code
          key={`c_${keyIdx++}`}
          className="rounded bg-[#F1F5F9] px-1.5 py-0.5 font-mono text-xs text-[#0F172A]"
        >
          {token.slice(1, -1)}
        </code>
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }

  return tokens;
}

function isMonospaceColumn(header: string): boolean {
  const lower = header.toLowerCase();
  return lower.includes('atf #') || lower === '#' || lower.includes('timestamp');
}

function isStanceColumn(header: string): boolean {
  return header.toLowerCase().includes('stance');
}

function MarkdownAnalysisRenderer({ markdown }: { markdown: string }) {
  const blocks = useMemo(() => parseMarkdownBlocks(markdown), [markdown]);

  return (
    <div className="space-y-5">
      {blocks.map((block, idx) => {
        if (block.type === 'heading') {
          return (
            <h3
              key={`h_${idx}`}
              className={`font-semibold tracking-tight text-[#0F172A] ${
                block.level <= 2 ? 'pt-2 text-lg' : 'pt-1 text-base'
              }`}
            >
              {renderInlineFormatting(block.text)}
            </h3>
          );
        }

        if (block.type === 'table') {
          return (
            <div
              key={`t_${idx}`}
              className="overflow-x-auto rounded-lg border border-[#E2E8F0] bg-white"
            >
              <table className="w-full min-w-[540px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                    {block.headers.map((header, hIdx) => (
                      <th
                        key={`th_${hIdx}`}
                        className={`px-3.5 py-2.5 text-xs font-semibold uppercase tracking-wide text-[#475569] ${
                          isMonospaceColumn(header) || isStanceColumn(header)
                            ? 'whitespace-nowrap'
                            : ''
                        }`}
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2E8F0]">
                  {block.rows.map((row, rIdx) => (
                    <tr
                      key={`tr_${rIdx}`}
                      className="transition-colors hover:bg-[#F8FAFC]"
                    >
                      {block.headers.map((header, cIdx) => {
                        const cell = row[cIdx] ?? '';
                        const mono = isMonospaceColumn(header);
                        const stance = isStanceColumn(header);
                        return (
                          <td
                            key={`td_${cIdx}`}
                            className={`align-top px-3.5 py-2.5 leading-relaxed ${
                              mono
                                ? 'whitespace-nowrap font-mono text-xs tabular-nums text-[#0F172A]'
                                : stance
                                  ? 'whitespace-nowrap text-xs font-medium text-[#0F172A]'
                                  : 'text-sm text-[#1E293B]'
                            }`}
                          >
                            {renderInlineFormatting(cell)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        if (block.type === 'list') {
          return (
            <ul key={`l_${idx}`} className="list-disc space-y-1.5 pl-5 text-sm text-[#334155]">
              {block.items.map((item, iIdx) => (
                <li key={`li_${iIdx}`} className="leading-relaxed">
                  {renderInlineFormatting(item)}
                </li>
              ))}
            </ul>
          );
        }

        return (
          <p
            key={`p_${idx}`}
            className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3 text-sm leading-relaxed text-[#334155]"
          >
            {renderInlineFormatting(block.text)}
          </p>
        );
      })}
    </div>
  );
}

export function GenAiAnalysisView({
  jobs,
  initialSelectedJobId,
  onSaveAnalysis,
  onSyncJobToDrive,
  driveEnabled = false,
  onGoToStudio,
}: GenAiAnalysisViewProps) {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(
    () => initialSelectedJobId || jobs[0]?.id || null
  );
  const [referenceStatus, setReferenceStatus] = useState<ReferenceStatus>({
    loading: true,
    available: false,
  });
  const [customRefFile, setCustomRefFile] = useState<File | null>(null);
  const [showRefPreview, setShowRefPreview] = useState(false);
  const [analyzingJobId, setAnalyzingJobId] = useState<string | null>(null);
  const [syncingDriveJobId, setSyncingDriveJobId] = useState<string | null>(null);
  const [stageLabel, setStageLabel] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<'formatted' | 'raw'>('formatted');
  const [copied, setCopied] = useState(false);

  const refInputRef = useRef<HTMLInputElement | null>(null);
  const pollCancelledRef = useRef(false);

  useEffect(() => {
    if (!selectedJobId && jobs.length > 0) {
      setSelectedJobId(jobs[0].id);
    } else if (selectedJobId && !jobs.some((j) => j.id === selectedJobId)) {
      setSelectedJobId(jobs[0]?.id ?? null);
    }
  }, [jobs, selectedJobId]);

  useEffect(() => {
    let active = true;
    fetch('/api/analysis/reference')
      .then((res) => res.json())
      .then((data: { ok?: boolean; available?: boolean; fileName?: string; publicUrl?: string }) => {
        if (!active) return;
        setReferenceStatus({
          loading: false,
          available: Boolean(data.available),
          fileName: data.fileName,
          publicUrl: data.publicUrl,
        });
      })
      .catch(() => {
        if (!active) return;
        setReferenceStatus({ loading: false, available: false });
      });

    return () => {
      active = false;
      pollCancelledRef.current = true;
    };
  }, []);

  const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? null;
  const isAnalyzingSelected = Boolean(selectedJob && analyzingJobId === selectedJob.id);
  const hasReferenceImage = referenceStatus.available || Boolean(customRefFile);

  function handleAttachReference(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setCustomRefFile(file);
      setErrorMessage(null);
    }
    e.target.value = '';
  }

  async function handleRunAnalysis(job: TranscriptJob) {
    if (analyzingJobId) return;
    if (!referenceStatus.available && !customRefFile) {
      setErrorMessage(
        'Place ATF60Stocks.jpg inside the /public folder (or attach ATF60Stocks.jpg above) before running Gen AI Analysis.'
      );
      return;
    }

    setAnalyzingJobId(job.id);
    setStageLabel('Generating transcript .txt file and attaching ATF60Stocks image...');
    setErrorMessage(null);
    pollCancelledRef.current = false;

    try {
      const txtContent = serializeToTXT(job);
      const txtFile = new File([txtContent], `${slugifyFilename(job.title)}.txt`, {
        type: 'text/plain',
      });

      const formData = new FormData();
      formData.append('transcript', txtFile);
      if (!referenceStatus.available && customRefFile) {
        formData.append('referenceImage', customRefFile);
      }

      const startRes = await fetch('/api/analyze', {
        method: 'POST',
        body: formData,
      });

      const startPayload = (await startRes.json()) as
        | { ok: true; analysisJobId: string; status: 'processing' }
        | { ok: false; message?: string };

      if (!startRes.ok || !startPayload.ok) {
        setErrorMessage(
          'message' in startPayload && startPayload.message
            ? startPayload.message
            : 'Failed to start Gen AI Analysis.'
        );
        return;
      }

      const { analysisJobId } = startPayload;
      while (!pollCancelledRef.current) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (pollCancelledRef.current) return;

        const pollRes = await fetch(`/api/analyze/jobs/${encodeURIComponent(analysisJobId)}`);
        if (!pollRes.ok) {
          setErrorMessage('Lost track of the Gen AI Analysis job. Please try again.');
          return;
        }

        const pollData = (await pollRes.json()) as AnalysisPollResponse;
        setStageLabel(pollData.stageLabel);

        if (pollData.status === 'completed' && pollData.analysis) {
          if (driveEnabled) {
            setSyncingDriveJobId(job.id);
            setStageLabel('Saving Gen AI Analysis to Google Drive folder...');
            try {
              await onSaveAnalysis(job.id, pollData.analysis);
            } finally {
              setSyncingDriveJobId(null);
            }
          } else {
            await onSaveAnalysis(job.id, pollData.analysis);
          }
          return;
        }

        if (pollData.status === 'failed') {
          setErrorMessage(pollData.error || 'Gen AI Analysis failed.');
          return;
        }
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? `Network error contacting analysis server: ${err.message}`
          : 'Could not reach analysis server.'
      );
    } finally {
      setAnalyzingJobId(null);
    }
  }

  async function handleCopyMarkdown(markdown: string) {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard fallback unavailable
    }
  }

  if (jobs.length === 0) {
    return (
      <section className="rounded-xl border border-[#E2E8F0] bg-white p-8 text-center sm:p-12">
        <Sparkles className="mx-auto h-7 w-7 text-[#0F172A]" aria-hidden="true" />
        <h1 className="mt-4 text-xl font-semibold tracking-tight text-[#0F172A]">
          No recent transcriptions available yet
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#475569]">
          Transcribe a video link or media file in Studio first. Once available, it appears here for ATF Top 60 Gen AI Analysis using the generated transcript file and reference image.
        </p>
        <button
          type="button"
          onClick={onGoToStudio}
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#BE123C] cursor-pointer"
        >
          Go to Studio
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header + Reference Image Status */}
      <section className="rounded-xl border border-[#E2E8F0] bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[#0F172A] sm:text-2xl">
              Gen AI Analysis
            </h1>
            <p className="mt-1 text-sm text-[#475569]">
              Select any recent transcription below to cross-reference the generated <span className="font-mono text-xs text-[#0F172A]">.txt</span> transcript file against <span className="font-mono text-xs text-[#0F172A]">ATF60Stocks.jpg</span>.
            </p>
          </div>

          {/* Reference Image Indicator */}
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={refInputRef}
              type="file"
              accept=".jpg,.jpeg,.png,image/jpeg,image/png"
              onChange={handleAttachReference}
              className="hidden"
            />
            {referenceStatus.loading ? (
              <span className="text-xs text-[#64748B]">Checking ATF60Stocks image...</span>
            ) : referenceStatus.available ? (
              <div className="flex items-center gap-3 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs text-[#334155]">
                <ImageIcon className="h-4 w-4 text-[#15803D]" aria-hidden="true" />
                <span className="font-mono">{referenceStatus.fileName}</span>
                {referenceStatus.publicUrl && (
                  <button
                    type="button"
                    onClick={() => setShowRefPreview((v) => !v)}
                    className="font-medium text-[#0F172A] underline underline-offset-4 hover:text-[#E11D48] cursor-pointer"
                  >
                    {showRefPreview ? 'Hide preview' : 'Preview'}
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#FDE68A] bg-[#FFFBEB] px-3 py-2 text-xs text-[#78350F]">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[#B45309]" aria-hidden="true" />
                <span>
                  {customRefFile
                    ? `Attached: ${customRefFile.name}`
                    : 'ATF60Stocks.jpg not found in /public'}
                </span>
                <button
                  type="button"
                  onClick={() => refInputRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded bg-[#0F172A] px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-[#1E293B] cursor-pointer"
                >
                  <Upload className="h-3 w-3" aria-hidden="true" />
                  {customRefFile ? 'Change JPG' : 'Attach JPG'}
                </button>
              </div>
            )}
          </div>
        </div>

        {showRefPreview && referenceStatus.publicUrl && (
          <div className="mt-4 overflow-hidden rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-3">
            <img
              src={referenceStatus.publicUrl}
              alt="ATF Top 60 Stocks reference image"
              className="mx-auto max-h-[420px] w-auto rounded object-contain"
            />
          </div>
        )}
      </section>

      {/* Split Workspace: Recent Transcriptions + Analysis Output */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left: Recent Transcriptions List */}
        <aside className="lg:col-span-4">
          <div className="rounded-xl border border-[#E2E8F0] bg-white p-4">
            <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-3">
              <h2 className="text-sm font-semibold text-[#0F172A]">
                Recent Transcriptions
              </h2>
              <span className="font-mono text-xs tabular-nums text-[#64748B]">
                {jobs.length} {jobs.length === 1 ? 'item' : 'items'}
              </span>
            </div>

            <div className="mt-3 space-y-2">
              {jobs.map((job) => {
                const isSelected = job.id === selectedJob?.id;
                const isRunningThis = analyzingJobId === job.id;
                return (
                  <button
                    key={job.id}
                    type="button"
                    title={job.title}
                    onClick={() => {
                      setSelectedJobId(job.id);
                      setErrorMessage(null);
                    }}
                    className={`w-full rounded-lg border p-3.5 text-left transition-colors cursor-pointer ${
                      isSelected
                        ? 'border-[#0F172A] bg-[#F8FAFC]'
                        : 'border-[#E2E8F0] bg-white hover:border-[#94A3B8]'
                    }`}
                  >
                    <p className="truncate text-sm font-medium text-[#0F172A]">
                      {truncateTitle(job.title, 50)}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-mono tabular-nums text-[#64748B]">
                        {job.language} · {formatDisplayTimestamp(job.durationSeconds)} · {job.segments.length} segs
                      </span>
                      <span
                        className={
                          isRunningThis
                            ? 'font-medium text-[#E11D48]'
                            : job.analysis
                              ? 'font-medium text-[#15803D]'
                              : 'text-[#64748B]'
                        }
                      >
                        {isRunningThis
                          ? 'Analyzing...'
                          : job.analysis
                            ? 'Analyzed'
                            : 'Ready'}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        {/* Right: Selected Transcript Analysis Panel */}
        <section className="lg:col-span-8">
          {selectedJob ? (
            <div className="rounded-xl border border-[#E2E8F0] bg-white p-5 sm:p-6">
              <div className="flex flex-col gap-4 border-b border-[#E2E8F0] pb-5 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h2
                    title={selectedJob.title}
                    className="text-lg font-semibold tracking-tight text-[#0F172A]"
                  >
                    {truncateTitle(selectedJob.title, 50)}
                  </h2>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#64748B]">
                    <span>
                      {selectedJob.language} · {formatDisplayTimestamp(selectedJob.durationSeconds)} · {selectedJob.segments.length} transcript segments
                    </span>
                    {selectedJob.analysis && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>
                          Engine: <span className="text-[#334155]">{selectedJob.analysis.engineUsed}</span>
                        </span>
                      </>
                    )}
                    {selectedJob.analysis && syncingDriveJobId === selectedJob.id && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-1 font-medium text-[#475569]">
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                          Saving analysis to Drive...
                        </span>
                      </>
                    )}
                    {selectedJob.analysis &&
                      syncingDriveJobId !== selectedJob.id &&
                      selectedJob.driveTranscriptFileIds?.analysisMdId && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span
                            title={
                              selectedJob.driveFolderName
                                ? `CueScript/${selectedJob.driveFolderName}/analysis.md`
                                : 'Saved in Google Drive video folder'
                            }
                            className="inline-flex items-center gap-1 font-medium text-[#16A34A]"
                          >
                            <HardDrive className="h-3 w-3" aria-hidden="true" />
                            Analysis cached in Drive
                          </span>
                        </>
                      )}
                    {selectedJob.analysis &&
                      syncingDriveJobId !== selectedJob.id &&
                      driveEnabled &&
                      !selectedJob.driveTranscriptFileIds?.analysisMdId &&
                      onSyncJobToDrive && (
                        <>
                          <span aria-hidden="true">·</span>
                          <button
                            type="button"
                            onClick={async () => {
                              setSyncingDriveJobId(selectedJob.id);
                              try {
                                await onSyncJobToDrive(selectedJob.id);
                              } finally {
                                setSyncingDriveJobId(null);
                              }
                            }}
                            className="inline-flex items-center gap-1 font-medium text-[#0F172A] underline underline-offset-4 hover:text-[#E11D48] cursor-pointer"
                          >
                            <HardDrive className="h-3 w-3" aria-hidden="true" />
                            Save analysis to Drive
                          </button>
                        </>
                      )}
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      triggerFileDownload(
                        serializeToTXT(selectedJob),
                        `${slugifyFilename(selectedJob.title)}.txt`,
                        'text/plain;charset=utf-8'
                      )
                    }
                    className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-xs font-medium text-[#334155] transition-colors hover:border-[#94A3B8] hover:text-[#0F172A] cursor-pointer"
                  >
                    <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                    Transcript .txt
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(analyzingJobId) || !hasReferenceImage}
                    onClick={() => handleRunAnalysis(selectedJob)}
                    className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#BE123C] disabled:cursor-not-allowed disabled:bg-[#CBD5E1] disabled:text-[#64748B] cursor-pointer"
                  >
                    {isAnalyzingSelected ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        Analyzing...
                      </>
                    ) : selectedJob.analysis ? (
                      <>
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        Re-run Gen AI Analysis
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                        Obtain Gen AI Analysis
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Error banner */}
              {errorMessage && (
                <div
                  role="alert"
                  className="mt-5 flex items-start gap-3 rounded-lg border border-[#FECDD3] bg-[#FFF1F2] p-4"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#BE123C]" aria-hidden="true" />
                  <p className="text-sm text-[#881337]">{errorMessage}</p>
                </div>
              )}

              {/* Loading state */}
              {isAnalyzingSelected && (
                <div
                  role="status"
                  aria-live="polite"
                  className="mt-5 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-5"
                >
                  <div className="flex items-center gap-3">
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#E11D48]" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-medium text-[#0F172A]">
                        {stageLabel || 'Running Gen AI Analysis...'}
                      </p>
                      <p className="mt-0.5 text-xs text-[#64748B]">
                        Sending attached ATF60Stocks image and generated .txt transcript file (OpenAI primary, Gemini fallback).
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Results view */}
              {selectedJob.analysis && !isAnalyzingSelected ? (
                <div className="mt-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div
                      role="tablist"
                      aria-label="Analysis output view"
                      className="inline-flex items-center gap-1 rounded-lg bg-[#F1F5F9] p-1"
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={displayMode === 'formatted'}
                        onClick={() => setDisplayMode('formatted')}
                        className={`rounded-md px-3 py-1 text-xs font-medium transition-colors cursor-pointer ${
                          displayMode === 'formatted'
                            ? 'bg-white text-[#0F172A] shadow-xs'
                            : 'text-[#475569] hover:text-[#0F172A]'
                        }`}
                      >
                        Formatted Tables
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={displayMode === 'raw'}
                        onClick={() => setDisplayMode('raw')}
                        className={`rounded-md px-3 py-1 text-xs font-medium transition-colors cursor-pointer ${
                          displayMode === 'raw'
                            ? 'bg-white text-[#0F172A] shadow-xs'
                            : 'text-[#475569] hover:text-[#0F172A]'
                        }`}
                      >
                        Raw Markdown
                      </button>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleCopyMarkdown(selectedJob.analysis!.markdown)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs font-medium text-[#334155] transition-colors hover:border-[#94A3B8] hover:text-[#0F172A] cursor-pointer"
                      >
                        {copied ? (
                          <>
                            <Check className="h-3.5 w-3.5 text-[#15803D]" aria-hidden="true" />
                            Copied
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                            Copy Markdown
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          triggerFileDownload(
                            selectedJob.analysis!.markdown,
                            `${slugifyFilename(selectedJob.title)}-atf-analysis.md`,
                            'text/markdown;charset=utf-8'
                          )
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#0F172A] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#1E293B] cursor-pointer"
                      >
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        Download .md
                      </button>
                    </div>
                  </div>

                  {displayMode === 'formatted' ? (
                    <MarkdownAnalysisRenderer markdown={selectedJob.analysis.markdown} />
                  ) : (
                    <pre className="overflow-x-auto rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-[#0F172A]">
                      {selectedJob.analysis.markdown}
                    </pre>
                  )}
                </div>
              ) : (
                !isAnalyzingSelected && (
                  <div className="mt-6 rounded-lg border border-dashed border-[#CBD5E1] bg-[#F8FAFC] px-6 py-10 text-center">
                    <Sparkles className="mx-auto h-6 w-6 text-[#475569]" aria-hidden="true" />
                    <p className="mt-3 text-sm font-medium text-[#0F172A]">
                      Ready to analyze this transcript against ATF Top 60 Stocks
                    </p>
                    <p className="mx-auto mt-1 max-w-lg text-xs leading-relaxed text-[#64748B]">
                      Click <span className="font-medium text-[#0F172A]">Obtain Gen AI Analysis</span> above to attach the generated <span className="font-mono">.txt</span> transcript file and <span className="font-mono">ATF60Stocks.jpg</span> and produce the 3 structured stock tables.
                    </p>
                  </div>
                )
              )}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
