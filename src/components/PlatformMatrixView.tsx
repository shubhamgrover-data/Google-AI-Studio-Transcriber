import { CheckSquare, Square } from 'lucide-react';
import { BUILD_CHECKLIST, PLATFORM_SPECS } from '../data/architectureData';

interface PlatformMatrixViewProps {
  completedStepIds: string[];
  onToggleStep: (stepId: string) => void;
}

export function PlatformMatrixView({
  completedStepIds,
  onToggleStep,
}: PlatformMatrixViewProps) {
  const completedCount = completedStepIds.length;
  const totalCount = BUILD_CHECKLIST.length;

  return (
    <div className="space-y-8">
      <div className="border-b border-[#E2E8F0] pb-6">
        <h1 className="text-2xl font-bold tracking-tight text-[#0F172A] sm:text-3xl">
          Platform extraction matrix: YouTube vs. Facebook vs. Instagram
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#475569]">
          Each social network defends its video streams differently. Designing your ingestion workers around these exact constraints prevents silent outages and broken user journeys.
        </p>
      </div>

      <section aria-label="Platform technical comparison">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          {PLATFORM_SPECS.map((platform) => (
            <article
              key={platform.id}
              className="flex flex-col rounded-xl border border-[#E2E8F0] bg-white p-6"
            >
              <div className="flex items-baseline justify-between gap-2 border-b border-[#E2E8F0] pb-4">
                <h2 className="text-lg font-semibold text-[#0F172A]">{platform.name}</h2>
                <span className="font-mono text-xs text-[#475569]">
                  {platform.reliabilityRating}
                </span>
              </div>

              <div className="mt-4 space-y-4 text-sm">
                <div>
                  <h3 className="text-xs font-semibold text-[#0F172A]">Supported URL Patterns</h3>
                  <div className="mt-1.5 space-y-1 font-mono text-xs text-[#475569]">
                    {platform.urlPatterns.map((pattern) => (
                      <div key={pattern} className="truncate">
                        {pattern}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="border-t border-[#F1F5F9] pt-3">
                  <h3 className="text-xs font-semibold text-[#0F172A]">Extraction Strategy</h3>
                  <p className="mt-1 text-xs leading-relaxed text-[#475569]">
                    {platform.extractionStrategy}
                  </p>
                </div>

                <div className="border-t border-[#F1F5F9] pt-3">
                  <h3 className="text-xs font-semibold text-[#0F172A]">Auth &amp; Anti-Bot Reality</h3>
                  <p className="mt-1 text-xs leading-relaxed text-[#475569]">
                    {platform.authAndAntiBot}
                  </p>
                </div>

                <div className="border-t border-[#F1F5F9] pt-3">
                  <h3 className="text-xs font-semibold text-[#BE123C]">
                    Primary Engineering Hurdles
                  </h3>
                  <ul className="mt-1.5 space-y-1.5 text-xs leading-relaxed text-[#475569]">
                    {platform.primaryHurdles.map((hurdle) => (
                      <li key={hurdle} className="flex items-start gap-2">
                        <span
                          aria-hidden="true"
                          className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#E11D48]"
                        />
                        <span>{hurdle}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="border-t border-[#F1F5F9] pt-3">
                  <h3 className="text-xs font-semibold text-[#15803D]">Recommended Fallback</h3>
                  <p className="mt-1 text-xs leading-relaxed text-[#334155]">
                    {platform.recommendedFallback}
                  </p>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section
        aria-label="Production launch roadmap checklist"
        className="rounded-xl border border-[#E2E8F0] bg-white p-6"
      >
        <div className="flex flex-col gap-3 border-b border-[#E2E8F0] pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[#0F172A]">Step-by-step build checklist</h2>
            <p className="mt-1 text-sm text-[#475569]">
              Track every component required to ship your own multi-platform transcription service from prototype to production.
            </p>
          </div>
          <div className="shrink-0 font-mono text-xs tabular-nums text-[#0F172A]">
            {completedCount} / {totalCount} completed
          </div>
        </div>

        <ol className="mt-2 divide-y divide-[#F1F5F9]">
          {BUILD_CHECKLIST.map((item) => {
            const isChecked = completedStepIds.includes(item.id);
            return (
              <li key={item.id} className="py-3.5">
                <button
                  type="button"
                  onClick={() => onToggleStep(item.id)}
                  aria-pressed={isChecked}
                  className="flex w-full items-start gap-3.5 text-left transition-colors cursor-pointer"
                >
                  <span className="mt-0.5 shrink-0 text-[#0F172A]">
                    {isChecked ? (
                      <CheckSquare className="h-4.5 w-4.5 text-[#15803D]" aria-hidden="true" />
                    ) : (
                      <Square className="h-4.5 w-4.5 text-[#94A3B8]" aria-hidden="true" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span className="font-mono text-xs tabular-nums text-[#64748B]">
                        {item.step}.
                      </span>
                      <span
                        className={`text-sm font-semibold ${
                          isChecked ? 'text-[#64748B] line-through' : 'text-[#0F172A]'
                        }`}
                      >
                        {item.title}
                      </span>
                      <span aria-hidden="true" className="text-[#CBD5E1]">
                        ·
                      </span>
                      <span className="text-xs text-[#64748B]">{item.category}</span>
                      <span aria-hidden="true" className="text-[#CBD5E1]">
                        ·
                      </span>
                      <span className="font-mono text-xs tabular-nums text-[#475569]">
                        Est. {item.effort}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-[#475569]">{item.detail}</p>
                  </div>
                </button>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
