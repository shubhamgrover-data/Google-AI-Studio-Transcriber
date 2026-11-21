import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Clock, Layers, ShieldAlert } from 'lucide-react';
import { ArchitectureView } from './components/ArchitectureView';
import { CostEstimatorView } from './components/CostEstimatorView';
import { IngestPanel } from './components/IngestPanel';
import { PlatformMatrixView } from './components/PlatformMatrixView';
import { StudioWorkspace } from './components/StudioWorkspace';
import { TopNav } from './components/TopNav';
import type {
  AppView,
  AsyncJobPollResponse,
  MediaPlatform,
  TranscribeApiError,
  TranscribeApiResponse,
  TranscriptJob,
} from './types/transcript';
import { formatDisplayTimestamp } from './utils/exporters';

const JOBS_STORAGE_KEY = 'cuescript_jobs_v1';
const CHECKLIST_STORAGE_KEY = 'cuescript_checklist_v1';

function loadStoredJobs(): TranscriptJob[] {
  try {
    const raw = localStorage.getItem(JOBS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TranscriptJob[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadStoredChecklist(): string[] {
  try {
    const raw = localStorage.getItem(CHECKLIST_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [activeView, setActiveView] = useState<AppView>('studio');
  const [jobs, setJobs] = useState<TranscriptJob[]>(loadStoredJobs);
  const [activeJobId, setActiveJobId] = useState<string | null>(() => loadStoredJobs()[0]?.id ?? null);
  const [showIngestForm, setShowIngestForm] = useState<boolean>(() => loadStoredJobs().length === 0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStep, setProcessingStep] = useState(0);
  const [processingDetail, setProcessingDetail] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [errorState, setErrorState] = useState<TranscribeApiError | null>(null);
  const [completedStepIds, setCompletedStepIds] = useState<string[]>(loadStoredChecklist);

  const pollCancelledRef = useRef(false);

  useEffect(() => {
    return () => {
      pollCancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    try {
      const serializable = jobs.slice(0, 12).map(({ localMediaUrl: _omit, ...rest }) => rest);
      localStorage.setItem(JOBS_STORAGE_KEY, JSON.stringify(serializable));
    } catch {
      // Ignore storage quota errors
    }
  }, [jobs]);

  useEffect(() => {
    try {
      localStorage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify(completedStepIds));
    } catch {
      // Ignore storage errors
    }
  }, [completedStepIds]);

  async function pollAsyncJob(asyncJobId: string, localMediaUrl?: string) {
    pollCancelledRef.current = false;

    while (!pollCancelledRef.current) {
      await new Promise((resolve) => setTimeout(resolve, 1400));
      if (pollCancelledRef.current) return;

      const pollRes = await fetch(`/api/jobs/${encodeURIComponent(asyncJobId)}`);
      if (!pollRes.ok) {
        if (localMediaUrl) URL.revokeObjectURL(localMediaUrl);
        setErrorState({
          ok: false,
          code: 'SERVER_ERROR',
          message: 'Lost track of background transcription job. Please try again.',
        });
        return;
      }

      const statusPayload = (await pollRes.json()) as AsyncJobPollResponse;
      setProcessingStep(statusPayload.stepIndex);
      setProcessingDetail(statusPayload.stageLabel);
      setProgressPct(statusPayload.progressPct);

      if (statusPayload.status === 'completed' && statusPayload.job) {
        const newJob: TranscriptJob = localMediaUrl
          ? { ...statusPayload.job, localMediaUrl }
          : statusPayload.job;
        setJobs((prev) => [newJob, ...prev.filter((j) => j.id !== newJob.id)]);
        setActiveJobId(newJob.id);
        setShowIngestForm(false);
        return;
      }

      if (statusPayload.status === 'failed') {
        if (localMediaUrl) URL.revokeObjectURL(localMediaUrl);
        setErrorState(
          statusPayload.error ?? {
            ok: false,
            code: 'SERVER_ERROR',
            message: 'Transcription job failed.',
          }
        );
        return;
      }
    }
  }

  async function handleSubmitUrl(url: string) {
    setIsProcessing(true);
    setProcessingStep(0);
    setProcessingDetail('Validating source & platform');
    setProgressPct(8);
    setErrorState(null);

    try {
      const response = await fetch('/api/transcribe/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      const payload = (await response.json()) as TranscribeApiResponse;
      if (!response.ok || !payload.ok) {
        setErrorState(
          payload.ok
            ? {
                ok: false,
                code: 'SERVER_ERROR',
                message: 'Unexpected server error while transcribing link.',
              }
            : payload
        );
        return;
      }

      if ('asyncJobId' in payload) {
        await pollAsyncJob(payload.asyncJobId);
        return;
      }

      const newJob: TranscriptJob = payload.job;
      setJobs((prev) => [newJob, ...prev.filter((j) => j.id !== newJob.id)]);
      setActiveJobId(newJob.id);
      setShowIngestForm(false);
    } catch (err) {
      setErrorState({
        ok: false,
        code: 'SERVER_ERROR',
        message:
          err instanceof Error
            ? `Network error contacting transcription server: ${err.message}`
            : 'Could not reach transcription server.',
      });
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleUploadFile(
    file: File,
    context?: { sourceUrl?: string; sourcePlatform?: MediaPlatform }
  ) {
    setIsProcessing(true);
    setProcessingStep(0);
    setProcessingDetail(`Uploading ${file.name}`);
    setProgressPct(10);
    setErrorState(null);
    const localMediaUrl = URL.createObjectURL(file);

    try {
      const formData = new FormData();
      formData.append('media', file);
      if (context?.sourceUrl) formData.append('sourceUrl', context.sourceUrl);
      if (context?.sourcePlatform) formData.append('sourcePlatform', context.sourcePlatform);

      const response = await fetch('/api/transcribe/upload', {
        method: 'POST',
        body: formData,
      });

      const payload = (await response.json()) as TranscribeApiResponse;
      if (!response.ok || !payload.ok) {
        URL.revokeObjectURL(localMediaUrl);
        setErrorState(
          payload.ok
            ? {
                ok: false,
                code: 'SERVER_ERROR',
                message: 'Unexpected server error while transcribing uploaded file.',
              }
            : payload
        );
        return;
      }

      if ('asyncJobId' in payload) {
        await pollAsyncJob(payload.asyncJobId, localMediaUrl);
        return;
      }

      const newJob: TranscriptJob = {
        ...payload.job,
        localMediaUrl,
      };
      setJobs((prev) => [newJob, ...prev.filter((j) => j.id !== newJob.id)]);
      setActiveJobId(newJob.id);
      setShowIngestForm(false);
    } catch (err) {
      URL.revokeObjectURL(localMediaUrl);
      setErrorState({
        ok: false,
        code: 'SERVER_ERROR',
        message:
          err instanceof Error
            ? `Upload failed: ${err.message}`
            : 'Could not upload media file to server.',
      });
    } finally {
      setIsProcessing(false);
    }
  }

  function handleRenameSpeaker(speakerId: string, newName: string) {
    if (!activeJobId) return;
    setJobs((prev) =>
      prev.map((job) =>
        job.id === activeJobId
          ? {
              ...job,
              speakers: {
                ...job.speakers,
                [speakerId]: newName,
              },
            }
          : job
      )
    );
  }

  function handleDeleteJob(jobId: string) {
    setJobs((prev) => {
      const next = prev.filter((j) => j.id !== jobId);
      if (activeJobId === jobId) {
        setActiveJobId(next[0]?.id ?? null);
        if (next.length === 0) setShowIngestForm(true);
      }
      return next;
    });
  }

  function handleNewTranscript() {
    setActiveView('studio');
    setShowIngestForm(true);
    setErrorState(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleToggleChecklistStep(stepId: string) {
    setCompletedStepIds((prev) =>
      prev.includes(stepId) ? prev.filter((id) => id !== stepId) : [...prev, stepId]
    );
  }

  const activeJob = jobs.find((j) => j.id === activeJobId) ?? null;

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A]">
      <TopNav
        activeView={activeView}
        onSelectView={setActiveView}
        onNewTranscript={handleNewTranscript}
      />

      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        {activeView === 'studio' && (
          <div className="space-y-6">
            {(showIngestForm || !activeJob) && (
              <IngestPanel
                isProcessing={isProcessing}
                processingStep={processingStep}
                processingDetail={processingDetail}
                progressPct={progressPct}
                errorState={errorState}
                onSubmitUrl={handleSubmitUrl}
                onUploadFile={handleUploadFile}
                onInspectPlatforms={() => setActiveView('platforms')}
                compact={Boolean(activeJob)}
              />
            )}

            {jobs.length > 0 && (
              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                <span className="shrink-0 text-xs font-medium text-[#64748B]">Recent:</span>
                {jobs.map((item) => {
                  const isCurrent = item.id === activeJob?.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setActiveJobId(item.id);
                        setShowIngestForm(false);
                      }}
                      className={`inline-flex max-w-[240px] shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors cursor-pointer ${
                        isCurrent
                          ? 'border-[#0F172A] bg-[#0F172A] font-medium text-white'
                          : 'border-[#E2E8F0] bg-white text-[#334155] hover:border-[#94A3B8]'
                      }`}
                    >
                      <span className="truncate">{item.title}</span>
                      <span
                        className={`shrink-0 font-mono text-[11px] tabular-nums ${
                          isCurrent ? 'text-slate-300' : 'text-[#64748B]'
                        }`}
                      >
                        {formatDisplayTimestamp(item.durationSeconds)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {activeJob ? (
              <StudioWorkspace
                job={activeJob}
                onRenameSpeaker={handleRenameSpeaker}
                onDeleteJob={handleDeleteJob}
              />
            ) : (
              <section
                aria-label="Service architecture overview"
                className="grid grid-cols-1 gap-5 pt-2 md:grid-cols-3"
              >
                <article className="flex flex-col justify-between rounded-xl border border-[#E2E8F0] bg-white p-6">
                  <div>
                    <Layers className="h-5 w-5 text-[#0F172A]" aria-hidden="true" />
                    <h2 className="mt-3 text-base font-semibold text-[#0F172A]">
                      01. Six-Stage Pipeline Blueprint
                    </h2>
                    <p className="mt-1.5 text-sm leading-relaxed text-[#475569]">
                      Inspect the exact async queue, yt-dlp audio extraction, FFmpeg 16 kHz normalization, speech-to-text diarization, and webhook architecture.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveView('architecture')}
                    className="mt-5 inline-flex items-center gap-1.5 self-start whitespace-nowrap text-xs font-semibold text-[#E11D48] hover:text-[#BE123C] cursor-pointer"
                  >
                    Explore architecture
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </article>

                <article className="flex flex-col justify-between rounded-xl border border-[#E2E8F0] bg-white p-6">
                  <div>
                    <ShieldAlert className="h-5 w-5 text-[#0F172A]" aria-hidden="true" />
                    <h2 className="mt-3 text-base font-semibold text-[#0F172A]">
                      02. YouTube, Facebook &amp; Instagram Matrix
                    </h2>
                    <p className="mt-1.5 text-sm leading-relaxed text-[#475569]">
                      Understand why YouTube works directly while Facebook and Instagram enforce login walls, plus the residential proxy and upload fallback patterns that keep jobs reliable.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveView('platforms')}
                    className="mt-5 inline-flex items-center gap-1.5 self-start whitespace-nowrap text-xs font-semibold text-[#E11D48] hover:text-[#BE123C] cursor-pointer"
                  >
                    View platform matrix
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </article>

                <article className="flex flex-col justify-between rounded-xl border border-[#E2E8F0] bg-white p-6">
                  <div>
                    <Clock className="h-5 w-5 text-[#0F172A]" aria-hidden="true" />
                    <h2 className="mt-3 text-base font-semibold text-[#0F172A]">
                      03. Cost &amp; Turnaround Estimator
                    </h2>
                    <p className="mt-1.5 text-sm leading-relaxed text-[#475569]">
                      Compare per-minute pricing and turnaround latency across Gemini Multimodal, Deepgram/AssemblyAI, and self-hosted WhisperX GPU workers at your target volume.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveView('estimator')}
                    className="mt-5 inline-flex items-center gap-1.5 self-start whitespace-nowrap text-xs font-semibold text-[#E11D48] hover:text-[#BE123C] cursor-pointer"
                  >
                    Open cost estimator
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </article>
              </section>
            )}
          </div>
        )}

        {activeView === 'architecture' && (
          <ArchitectureView
            onOpenPlatforms={() => setActiveView('platforms')}
            onOpenEstimator={() => setActiveView('estimator')}
          />
        )}

        {activeView === 'platforms' && (
          <PlatformMatrixView
            completedStepIds={completedStepIds}
            onToggleStep={handleToggleChecklistStep}
          />
        )}

        {activeView === 'estimator' && <CostEstimatorView />}
      </main>
    </div>
  );
}
