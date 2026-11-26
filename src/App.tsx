import { useCallback, useEffect, useRef, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { AskAiWidget } from './components/AskAiWidget';
import { DriveSetupModal } from './components/DriveSetupModal';
import { GenAiAnalysisView } from './components/GenAiAnalysisView';
import { IngestPanel } from './components/IngestPanel';
import { RecommendationsView } from './components/RecommendationsView';
import { StudioWorkspace } from './components/StudioWorkspace';
import { TopNav } from './components/TopNav';
import type { AskAiContext } from './types/askAi';
import type {
  AppView,
  AsyncJobPollResponse,
  DriveStatusResponse,
  MediaPlatform,
  RecommendationSnapshot,
  RefreshMode,
  TranscribeApiError,
  TranscribeApiResponse,
  TranscriptAnalysisResult,
  TranscriptJob,
} from './types/transcript';
import { formatDisplayTimestamp, truncateTitle } from './utils/exporters';

const JOBS_STORAGE_KEY = 'cuescript_jobs_v1';
const LATEST_REC_STORAGE_KEY = 'cuescript_latest_recommendation_v1';

function loadStoredRecommendation(): RecommendationSnapshot | null {
  try {
    const raw = localStorage.getItem(LATEST_REC_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RecommendationSnapshot;
    if (parsed && typeof parsed.markdown === 'string' && typeof parsed.formattedTimestamp === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

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

function mergeJobLists(driveJobs: TranscriptJob[], localJobs: TranscriptJob[]): TranscriptJob[] {
  const byKey = new Map<string, TranscriptJob>();
  const keyOf = (j: TranscriptJob) => (j.sourceKey ? `sk:${j.sourceKey}` : `id:${j.id}`);

  for (const d of driveJobs) {
    byKey.set(keyOf(d), d);
  }
  for (const l of localJobs) {
    const k = keyOf(l);
    const existing = byKey.get(k);
    if (!existing) {
      byKey.set(k, l);
    } else {
      const mergedItem: TranscriptJob = {
        ...existing,
        ...(l.localMediaUrl && !existing.localMediaUrl ? { localMediaUrl: l.localMediaUrl } : {}),
        ...(l.analysis && !existing.analysis ? { analysis: l.analysis } : {}),
      };
      byKey.set(k, mergedItem);
    }
  }

  return Array.from(byKey.values()).sort(
    (a, b) =>
      new Date(b.syncedAt || b.createdAt).getTime() -
      new Date(a.syncedAt || a.createdAt).getTime()
  );
}

function upsertJob(list: TranscriptJob[], incoming: TranscriptJob): TranscriptJob[] {
  const filtered = list.filter((item) => {
    if (item.id === incoming.id) return false;
    if (incoming.sourceKey && item.sourceKey && item.sourceKey === incoming.sourceKey) {
      return false;
    }
    return true;
  });
  return [incoming, ...filtered];
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

  // Headless personal Google Drive Bridge state (session token strictly in JS memory, never localStorage)
  const [driveStatus, setDriveStatus] = useState<DriveStatusResponse | null>(null);
  const [driveSessionToken, setDriveSessionToken] = useState<string | null>(null);
  const [isSyncingLibrary, setIsSyncingLibrary] = useState(false);
  const [isVerifyingDrive, setIsVerifyingDrive] = useState(false);
  const [isSetupModalOpen, setIsSetupModalOpen] = useState(false);

  // Latest consolidated stock recommendations (cached locally + synced with CueScript/Recommendations/ in Drive)
  const [latestRecommendation, setLatestRecommendation] = useState<RecommendationSnapshot | null>(
    loadStoredRecommendation
  );
  const [isLoadingLatestRec, setIsLoadingLatestRec] = useState(false);
  const [driveRecNeedsBridgeUpdate, setDriveRecNeedsBridgeUpdate] = useState(false);

  // Studio inline transcript refresh state
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshDetail, setRefreshDetail] = useState('');
  const [refreshProgressPct, setRefreshProgressPct] = useState(0);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Shared reusable Ask AI floating widget state (same chatbot across all tabs, only fed data changes)
  const [isAskAiOpen, setIsAskAiOpen] = useState(false);
  const [askAiContext, setAskAiContext] = useState<AskAiContext | null>(null);

  const handleOpenAskAi = useCallback((context: AskAiContext) => {
    setAskAiContext(context);
    setIsAskAiOpen(true);
  }, []);

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
      if (latestRecommendation) {
        localStorage.setItem(LATEST_REC_STORAGE_KEY, JSON.stringify(latestRecommendation));
      }
    } catch {
      // Ignore storage quota errors
    }
  }, [latestRecommendation]);

  const buildDriveHeaders = useCallback(
    (tokenOverride?: string | null): Record<string, string> => {
      const token = tokenOverride !== undefined ? tokenOverride : driveSessionToken;
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
    [driveSessionToken]
  );

  const fetchLatestRecommendationFromDrive = useCallback(
    async (tokenOverride?: string | null) => {
      setIsLoadingLatestRec(true);
      try {
        const headers = buildDriveHeaders(tokenOverride);
        const res = await fetch('/api/recommendations/latest', { headers });
        if (!res.ok) return;
        const data = (await res.json()) as {
          ok: boolean;
          hasRecommendation?: boolean;
          needsBridgeUpdate?: boolean;
          recommendation?: RecommendationSnapshot;
        };
        setDriveRecNeedsBridgeUpdate(Boolean(data.needsBridgeUpdate));
        if (data.ok && data.hasRecommendation && data.recommendation) {
          const driveRec = data.recommendation;
          setLatestRecommendation((prev) => {
            if (!prev) return driveRec;
            const prevTime = new Date(prev.generatedAt).getTime();
            const driveTime = new Date(driveRec.generatedAt).getTime();
            if (!Number.isFinite(prevTime) || driveTime >= prevTime) {
              return driveRec;
            }
            return prev;
          });
        }
      } catch {
        // Keep locally cached latest recommendation on transient error
      } finally {
        setIsLoadingLatestRec(false);
      }
    },
    [buildDriveHeaders]
  );

  const fetchDriveStatusAndLibrary = useCallback(
    async (tokenOverride?: string | null) => {
      setIsVerifyingDrive(true);
      try {
        const headers = buildDriveHeaders(tokenOverride);
        const statusRes = await fetch('/api/drive/status', { headers });
        if (!statusRes.ok) return;
        const statusData = (await statusRes.json()) as DriveStatusResponse;
        setDriveStatus(statusData);

        if (statusData.configured && statusData.unlocked && statusData.reachable) {
          setIsSyncingLibrary(true);
          try {
            const libPromise = fetch('/api/drive/library', { headers })
              .then(async (libRes) => {
                if (!libRes.ok) return;
                const libData = (await libRes.json()) as { ok: true; jobs?: TranscriptJob[] };
                const driveJobs = Array.isArray(libData.jobs) ? libData.jobs : [];
                if (driveJobs.length > 0) {
                  setJobs((prev) => {
                    const merged = mergeJobLists(driveJobs, prev);
                    setActiveJobId((currId) => currId ?? merged[0]?.id ?? null);
                    return merged;
                  });
                }
              })
              .catch(() => {});

            const recPromise = fetchLatestRecommendationFromDrive(tokenOverride);
            await Promise.all([libPromise, recPromise]);
          } finally {
            setIsSyncingLibrary(false);
          }
        }
      } catch {
        // Keep local mode working seamlessly if Drive status check fails
      } finally {
        setIsVerifyingDrive(false);
      }
    },
    [buildDriveHeaders, fetchLatestRecommendationFromDrive]
  );

  useEffect(() => {
    void fetchDriveStatusAndLibrary();
  }, [fetchDriveStatusAndLibrary]);

  async function handleUnlockDrive(passcode: string): Promise<string | null> {
    try {
      const res = await fetch('/api/drive/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode }),
      });
      const data = (await res.json()) as { ok: boolean; token?: string; message?: string };
      if (!res.ok || !data.ok || !data.token) {
        return data.message || 'Incorrect passcode.';
      }
      setDriveSessionToken(data.token);
      await fetchDriveStatusAndLibrary(data.token);
      return null;
    } catch {
      return 'Could not reach server to verify passcode.';
    }
  }

  function handleLockDrive() {
    setDriveSessionToken(null);
    setDriveStatus((prev) => (prev ? { ...prev, unlocked: false } : prev));
  }

  async function pollAsyncJob(
    asyncJobId: string,
    options?: {
      localMediaUrl?: string;
      mode?: 'ingest' | 'refresh';
    }
  ) {
    pollCancelledRef.current = false;
    const isRefreshMode = options?.mode === 'refresh';

    while (!pollCancelledRef.current) {
      await new Promise((resolve) => setTimeout(resolve, 1400));
      if (pollCancelledRef.current) return;

      const pollRes = await fetch(`/api/jobs/${encodeURIComponent(asyncJobId)}`);
      if (!pollRes.ok) {
        if (options?.localMediaUrl) URL.revokeObjectURL(options.localMediaUrl);
        setErrorState({
          ok: false,
          code: 'SERVER_ERROR',
          message: 'Lost track of background transcription job. Please try again.',
        });
        return;
      }

      const statusPayload = (await pollRes.json()) as AsyncJobPollResponse;
      if (isRefreshMode) {
        setRefreshDetail(statusPayload.stageLabel);
        setRefreshProgressPct(statusPayload.progressPct);
      } else {
        setProcessingStep(statusPayload.stepIndex);
        setProcessingDetail(statusPayload.stageLabel);
        setProgressPct(statusPayload.progressPct);
      }

      if (statusPayload.status === 'completed' && statusPayload.job) {
        const newJob: TranscriptJob = options?.localMediaUrl
          ? { ...statusPayload.job, localMediaUrl: options.localMediaUrl }
          : statusPayload.job;
        setJobs((prev) => upsertJob(prev, newJob));
        setActiveJobId(newJob.id);
        setShowIngestForm(false);
        return;
      }

      if (statusPayload.status === 'failed') {
        if (options?.localMediaUrl) URL.revokeObjectURL(options.localMediaUrl);
        const failErr = statusPayload.error ?? {
          ok: false as const,
          code: 'SERVER_ERROR' as const,
          message: 'Transcription job failed.',
        };
        if (isRefreshMode) {
          setRefreshError(failErr.message);
        } else {
          setErrorState(failErr);
        }
        return;
      }
    }
  }

  async function handleSubmitUrl(url: string) {
    setIsProcessing(true);
    setProcessingStep(0);
    setProcessingDetail('Checking Google Drive cache & validating source...');
    setProgressPct(8);
    setErrorState(null);

    try {
      const response = await fetch('/api/transcribe/url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildDriveHeaders(),
        },
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
        await pollAsyncJob(payload.asyncJobId, { mode: 'ingest' });
        return;
      }

      // Instant auto-open on Google Drive cache hit!
      const newJob: TranscriptJob = payload.job;
      setJobs((prev) => upsertJob(prev, newJob));
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

  async function handleRefreshTranscript(job: TranscriptJob, mode: RefreshMode) {
    if (!job.sourceUrl || isRefreshing || isProcessing) return;
    setIsRefreshing(true);
    setRefreshDetail(
      mode === 'audio'
        ? 'Loading cached audio from Google Drive...'
        : 'Starting fresh audio extraction & transcription...'
    );
    setRefreshProgressPct(12);
    setRefreshError(null);

    try {
      const response = await fetch('/api/transcribe/url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildDriveHeaders(),
        },
        body: JSON.stringify({
          url: job.sourceUrl,
          refreshMode: mode,
          driveAudioFileId: job.driveAudioFileId,
          existingTitle: job.title,
          existingAuthor: job.author,
          existingThumbnailUrl: job.thumbnailUrl,
        }),
      });

      const payload = (await response.json()) as TranscribeApiResponse;
      if (!response.ok || !payload.ok) {
        setRefreshError(
          payload.ok ? 'Could not refresh transcript.' : payload.message
        );
        return;
      }

      if ('asyncJobId' in payload) {
        await pollAsyncJob(payload.asyncJobId, { mode: 'refresh' });
        return;
      }

      setJobs((prev) => upsertJob(prev, payload.job));
      setActiveJobId(payload.job.id);
    } catch (err) {
      setRefreshError(
        err instanceof Error
          ? `Network error while refreshing transcript: ${err.message}`
          : 'Could not reach server to refresh transcript.'
      );
    } finally {
      setIsRefreshing(false);
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
        headers: buildDriveHeaders(),
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
        await pollAsyncJob(payload.asyncJobId, { localMediaUrl, mode: 'ingest' });
        return;
      }

      const newJob: TranscriptJob = {
        ...payload.job,
        localMediaUrl,
      };
      setJobs((prev) => upsertJob(prev, newJob));
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

  async function syncUpdatedJobToDrive(updatedJob: TranscriptJob): Promise<boolean> {
    if (!driveStatus?.configured || !driveStatus.unlocked || !driveStatus.reachable) {
      return false;
    }
    const effectiveSourceKey = updatedJob.sourceKey || updatedJob.id;
    if (!effectiveSourceKey) return false;

    const { localMediaUrl: _omit, ...serializable } = updatedJob;
    try {
      const res = await fetch(`/api/drive/transcripts/${encodeURIComponent(effectiveSourceKey)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...buildDriveHeaders(),
        },
        body: JSON.stringify({
          job: {
            ...serializable,
            sourceKey: effectiveSourceKey,
          },
        }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as {
        ok?: boolean;
        driveFolderId?: string;
        driveFolderName?: string;
        transcriptFiles?: TranscriptJob['driveTranscriptFileIds'];
        syncedAt?: string;
      };
      if (!data.ok) return false;

      setJobs((prev) =>
        prev.map((j) =>
          j.id === updatedJob.id
            ? {
                ...j,
                sourceKey: effectiveSourceKey,
                driveFolderId: data.driveFolderId || j.driveFolderId,
                driveFolderName: data.driveFolderName || j.driveFolderName,
                driveTranscriptFileIds: data.transcriptFiles || j.driveTranscriptFileIds,
                syncedToDrive: true,
                syncedAt: data.syncedAt || j.syncedAt,
              }
            : j
        )
      );
      return true;
    } catch {
      return false;
    }
  }

  function handleRenameSpeaker(speakerId: string, newName: string) {
    if (!activeJobId) return;
    let updatedForDrive: TranscriptJob | null = null;
    setJobs((prev) =>
      prev.map((job) => {
        if (job.id !== activeJobId) return job;
        const updated: TranscriptJob = {
          ...job,
          speakers: {
            ...job.speakers,
            [speakerId]: newName,
          },
        };
        updatedForDrive = updated;
        return updated;
      })
    );
    if (updatedForDrive) {
      void syncUpdatedJobToDrive(updatedForDrive);
    }
  }

  async function handleSaveAnalysis(
    jobId: string,
    analysis: TranscriptAnalysisResult
  ): Promise<boolean> {
    const existing = jobs.find((j) => j.id === jobId);
    const updatedForDrive: TranscriptJob | null = existing
      ? {
          ...existing,
          sourceKey: existing.sourceKey || existing.id,
          analysis,
        }
      : null;

    setJobs((prev) =>
      prev.map((job) => {
        if (job.id !== jobId) return job;
        return {
          ...job,
          sourceKey: job.sourceKey || job.id,
          analysis,
        };
      })
    );

    if (updatedForDrive) {
      return syncUpdatedJobToDrive(updatedForDrive);
    }
    return false;
  }

  async function handleSyncJobToDrive(jobId: string): Promise<boolean> {
    const target = jobs.find((j) => j.id === jobId);
    if (!target) return false;
    return syncUpdatedJobToDrive({
      ...target,
      sourceKey: target.sourceKey || target.id,
    });
  }

  function handleRecommendationGenerated(snapshot: RecommendationSnapshot) {
    setLatestRecommendation(snapshot);
    if (snapshot.syncedToDrive) {
      setDriveRecNeedsBridgeUpdate(false);
    } else if (snapshot.driveSyncWarning && /code\.gs|bridge/i.test(snapshot.driveSyncWarning)) {
      setDriveRecNeedsBridgeUpdate(true);
    }
  }

  async function handleSyncRecommendationToDrive(snapshot: RecommendationSnapshot): Promise<{
    ok: boolean;
    needsBridgeUpdate?: boolean;
    error?: string;
  }> {
    try {
      const res = await fetch('/api/recommendations/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildDriveHeaders(),
        },
        body: JSON.stringify({ recommendation: snapshot }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        needsBridgeUpdate?: boolean;
        message?: string;
        driveFiles?: RecommendationSnapshot['driveFiles'];
      };
      if (!res.ok || !data.ok) {
        if (data.needsBridgeUpdate) setDriveRecNeedsBridgeUpdate(true);
        return {
          ok: false,
          needsBridgeUpdate: data.needsBridgeUpdate,
          error: data.message || 'Could not save recommendation to Drive.',
        };
      }
      setDriveRecNeedsBridgeUpdate(false);
      setLatestRecommendation((prev) =>
        prev && prev.id === snapshot.id
          ? {
              ...prev,
              syncedToDrive: true,
              driveFiles: data.driveFiles || prev.driveFiles,
              driveSyncWarning: undefined,
            }
          : prev
      );
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Network error syncing to Google Drive.',
      };
    }
  }

  async function handleDeleteJob(jobId: string, deleteFromDrive: boolean) {
    const target = jobs.find((j) => j.id === jobId);
    if (deleteFromDrive && target?.sourceKey && driveStatus?.configured && driveStatus.unlocked) {
      try {
        await fetch(`/api/drive/transcripts/${encodeURIComponent(target.sourceKey)}`, {
          method: 'DELETE',
          headers: buildDriveHeaders(),
        });
      } catch {
        // Still remove locally if Drive trash fails transiently
      }
    }

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

  const activeJob = jobs.find((j) => j.id === activeJobId) ?? null;
  const driveEnabled = Boolean(
    driveStatus?.configured && driveStatus.unlocked && driveStatus.reachable
  );

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
                compact={Boolean(activeJob)}
                driveStatus={driveStatus}
                isSyncingLibrary={isSyncingLibrary}
                onOpenDriveSetup={() => setIsSetupModalOpen(true)}
                onSyncDriveLibrary={() => void fetchDriveStatusAndLibrary()}
                onUnlockDrive={handleUnlockDrive}
                onLockDrive={handleLockDrive}
              />
            )}

            {jobs.length > 0 && (
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2 overflow-x-auto pb-1">
                  <span className="shrink-0 text-xs font-medium text-[#64748B]">Recent:</span>
                  {jobs.map((item) => {
                    const isCurrent = item.id === activeJob?.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        title={item.title}
                        onClick={() => {
                          setActiveJobId(item.id);
                          setShowIngestForm(false);
                        }}
                        className={`inline-flex max-w-[280px] shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors cursor-pointer ${
                          isCurrent
                            ? 'border-[#0F172A] bg-[#0F172A] font-medium text-white'
                            : 'border-[#E2E8F0] bg-white text-[#334155] hover:border-[#94A3B8]'
                        }`}
                      >
                        {item.syncedToDrive && (
                          <HardDrive
                            className={`h-3 w-3 shrink-0 ${
                              isCurrent ? 'text-emerald-400' : 'text-[#16A34A]'
                            }`}
                            aria-hidden="true"
                          />
                        )}
                        <span className="truncate">{truncateTitle(item.title, 50)}</span>
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

                {!showIngestForm && driveStatus && !driveEnabled && (
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (driveStatus.configured && driveStatus.requiresPasscode && !driveStatus.unlocked) {
                          setShowIngestForm(true);
                        } else {
                          setIsSetupModalOpen(true);
                        }
                      }}
                      className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#CBD5E1] bg-white px-3 py-1.5 text-xs font-medium text-[#334155] transition-colors hover:border-[#0F172A] hover:text-[#0F172A] cursor-pointer"
                    >
                      <HardDrive className="h-3.5 w-3.5 text-[#64748B]" aria-hidden="true" />
                      {driveStatus.configured && driveStatus.requiresPasscode && !driveStatus.unlocked
                        ? 'Unlock Drive'
                        : 'Drive Setup'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {activeJob && (
              <StudioWorkspace
                job={activeJob}
                onRenameSpeaker={handleRenameSpeaker}
                onDeleteJob={handleDeleteJob}
                onRefreshTranscript={handleRefreshTranscript}
                isRefreshing={isRefreshing}
                refreshDetail={refreshDetail}
                refreshProgressPct={refreshProgressPct}
                refreshError={refreshError}
                onDismissRefreshError={() => setRefreshError(null)}
                driveEnabled={driveEnabled}
                driveSessionToken={driveSessionToken}
                onOpenAskAi={handleOpenAskAi}
              />
            )}
          </div>
        )}

        {activeView === 'analysis' && (
          <GenAiAnalysisView
            jobs={jobs}
            initialSelectedJobId={activeJobId}
            onSaveAnalysis={handleSaveAnalysis}
            onSyncJobToDrive={handleSyncJobToDrive}
            driveEnabled={driveEnabled}
            onGoToStudio={() => setActiveView('studio')}
            onOpenAskAi={handleOpenAskAi}
          />
        )}

        {activeView === 'recommendations' && (
          <RecommendationsView
            jobs={jobs}
            latestRecommendation={latestRecommendation}
            isLoadingLatest={isLoadingLatestRec}
            driveEnabled={driveEnabled}
            driveNeedsBridgeUpdate={driveRecNeedsBridgeUpdate}
            buildDriveHeaders={buildDriveHeaders}
            onRecommendationGenerated={handleRecommendationGenerated}
            onSyncRecommendationToDrive={handleSyncRecommendationToDrive}
            onRefreshLatestFromDrive={() => fetchLatestRecommendationFromDrive()}
            onOpenDriveSetup={() => setIsSetupModalOpen(true)}
            onGoToAnalysis={() => setActiveView('analysis')}
            onOpenAskAi={handleOpenAskAi}
          />
        )}
      </main>

      <DriveSetupModal
        isOpen={isSetupModalOpen}
        onClose={() => setIsSetupModalOpen(false)}
        driveStatus={driveStatus}
        onVerifyConnection={() => fetchDriveStatusAndLibrary()}
        isVerifying={isVerifyingDrive}
      />

      <AskAiWidget
        isOpen={isAskAiOpen}
        context={askAiContext}
        onClose={() => setIsAskAiOpen(false)}
      />
    </div>
  );
}
