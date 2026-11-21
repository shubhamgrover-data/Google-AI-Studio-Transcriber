import { useState } from 'react';
import { ArrowRight, Check, Copy } from 'lucide-react';
import { PIPELINE_STAGES } from '../data/architectureData';

interface ArchitectureViewProps {
  onOpenPlatforms: () => void;
  onOpenEstimator: () => void;
}

const CURL_EXAMPLE = `curl -X POST ${typeof window !== 'undefined' ? window.location.origin : 'https://your-service.example.com'}/api/transcribe/url \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  }'`;

export function ArchitectureView({
  onOpenPlatforms,
  onOpenEstimator,
}: ArchitectureViewProps) {
  const [selectedStageId, setSelectedStageId] = useState(PIPELINE_STAGES[0].id);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const selectedStage =
    PIPELINE_STAGES.find((stage) => stage.id === selectedStageId) ?? PIPELINE_STAGES[0];

  async function copyCode(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // Clipboard blocked
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 border-b border-[#E2E8F0] pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl">
          <h1 className="text-2xl font-bold tracking-tight text-[#0F172A] sm:text-3xl">
            How to build a YouTube, Facebook &amp; Instagram transcription service
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-[#475569]">
            A production link-to-transcript service is an asynchronous media pipeline, not a single API call. Click any stage below to inspect the exact stack, failure modes, and reference code required to take links from YouTube, Facebook, and Instagram and output synced transcripts with timestamps.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onOpenPlatforms}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#CBD5E1] bg-white px-4 py-2 text-xs font-medium text-[#0F172A] transition-colors hover:border-[#0F172A] cursor-pointer"
          >
            YT / FB / IG Matrix
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onOpenEstimator}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-[#0F172A] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#1E293B] cursor-pointer"
          >
            Estimate Costs
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <section aria-label="Six-stage transcription pipeline">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
          {PIPELINE_STAGES.map((stage) => {
            const isSelected = stage.id === selectedStage.id;
            return (
              <button
                key={stage.id}
                type="button"
                onClick={() => setSelectedStageId(stage.id)}
                aria-pressed={isSelected}
                className={`flex flex-col justify-between rounded-xl border p-4 text-left transition-colors duration-150 cursor-pointer ${
                  isSelected
                    ? 'border-[#0F172A] bg-[#0F172A] text-white'
                    : 'border-[#E2E8F0] bg-white text-[#0F172A] hover:border-[#94A3B8]'
                }`}
              >
                <div>
                  <span
                    className={`font-mono text-xs tabular-nums ${
                      isSelected ? 'text-[#FB7185]' : 'text-[#64748B]'
                    }`}
                  >
                    {stage.order}
                  </span>
                  <h2 className="mt-1.5 text-sm font-semibold leading-snug">{stage.title}</h2>
                </div>
                <p
                  className={`mt-3 text-xs ${
                    isSelected ? 'text-slate-300' : 'text-[#64748B]'
                  }`}
                >
                  {stage.role}
                </p>
              </button>
            );
          })}
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 rounded-xl border border-[#E2E8F0] bg-white p-6 lg:grid-cols-12">
          <div className="space-y-5 lg:col-span-6">
            <div>
              <p className="font-mono text-xs tabular-nums text-[#E11D48]">
                Stage {selectedStage.order} · {selectedStage.role}
              </p>
              <h3 className="mt-1 text-xl font-semibold text-[#0F172A]">
                {selectedStage.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-[#475569]">
                {selectedStage.summary}
              </p>
            </div>

            <div className="border-t border-[#E2E8F0] pt-4">
              <h4 className="text-xs font-semibold text-[#0F172A]">Recommended Stack</h4>
              <p className="mt-1 font-mono text-xs text-[#334155]">
                {selectedStage.recommendedStack}
              </p>
            </div>

            <div className="border-t border-[#E2E8F0] pt-4">
              <h4 className="text-xs font-semibold text-[#0F172A]">Core Responsibilities</h4>
              <ul className="mt-2 space-y-2 text-sm leading-relaxed text-[#334155]">
                {selectedStage.responsibilities.map((item) => (
                  <li key={item} className="flex items-start gap-2.5">
                    <span
                      aria-hidden="true"
                      className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#0F172A]"
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="border-t border-[#E2E8F0] pt-4">
              <h4 className="text-xs font-semibold text-[#BE123C]">
                Common Production Failure Modes
              </h4>
              <ul className="mt-2 space-y-2 text-sm leading-relaxed text-[#475569]">
                {selectedStage.failureModes.map((item) => (
                  <li key={item} className="flex items-start gap-2.5">
                    <span
                      aria-hidden="true"
                      className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#E11D48]"
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="flex flex-col overflow-hidden rounded-xl border border-[#0F172A] bg-[#0F172A] text-slate-100 lg:col-span-6">
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-white">
                  {selectedStage.codeTitle}
                </p>
                <p className="font-mono text-[11px] text-slate-400">
                  {selectedStage.codeLanguage}
                </p>
              </div>
              <button
                type="button"
                onClick={() => copyCode(selectedStage.id, selectedStage.codeSnippet)}
                className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-slate-500 hover:text-white cursor-pointer"
              >
                {copiedId === selectedStage.id ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    Copy
                  </>
                )}
              </button>
            </div>
            <pre className="flex-1 overflow-x-auto p-4 font-mono text-xs leading-relaxed text-slate-200">
              <code>{selectedStage.codeSnippet}</code>
            </pre>
          </div>
        </div>
      </section>

      <section
        aria-label="CueScript live API contract"
        className="grid grid-cols-1 gap-6 rounded-xl border border-[#E2E8F0] bg-white p-6 lg:grid-cols-12"
      >
        <div className="lg:col-span-5">
          <h2 className="text-lg font-semibold text-[#0F172A]">
            Live API running in this studio
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-[#475569]">
            The Express backend behind CueScript implements two real endpoints so you can test the request/response lifecycle directly:
          </p>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="border-t border-[#F1F5F9] pt-3">
              <dt className="font-mono text-xs font-semibold text-[#0F172A]">
                POST /api/transcribe/url
              </dt>
              <dd className="mt-1 text-xs leading-relaxed text-[#475569]">
                Validates YouTube, Facebook, Instagram, or direct media URLs. Transcribes public YouTube links natively via Gemini fileUri; probes public Meta streams and returns structured LOGIN_WALL_FALLBACK diagnostics when blocked.
              </dd>
            </div>
            <div className="border-t border-[#F1F5F9] pt-3">
              <dt className="font-mono text-xs font-semibold text-[#0F172A]">
                POST /api/transcribe/upload
              </dt>
              <dd className="mt-1 text-xs leading-relaxed text-[#475569]">
                Accepts multipart form-data (field: media, up to 25 MB). Automatically routes clips over 12 MB through Gemini Files API with ephemeral cleanup after structured JSON generation.
              </dd>
            </div>
          </dl>
        </div>

        <div className="flex flex-col overflow-hidden rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] lg:col-span-7">
          <div className="flex items-center justify-between border-b border-[#E2E8F0] px-4 py-2.5">
            <span className="font-mono text-xs font-medium text-[#0F172A]">
              Example Request (cURL)
            </span>
            <button
              type="button"
              onClick={() => copyCode('curl', CURL_EXAMPLE)}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[#CBD5E1] bg-white px-2.5 py-1 text-xs font-medium text-[#0F172A] hover:border-[#0F172A] cursor-pointer"
            >
              {copiedId === 'curl' ? (
                <>
                  <Check className="h-3.5 w-3.5 text-[#15803D]" aria-hidden="true" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  Copy
                </>
              )}
            </button>
          </div>
          <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-[#1E293B]">
            <code>{CURL_EXAMPLE}</code>
          </pre>
        </div>
      </section>
    </div>
  );
}
