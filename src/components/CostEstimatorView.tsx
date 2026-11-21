import { useMemo, useState } from 'react';
import { COST_ENGINES } from '../data/architectureData';

export function CostEstimatorView() {
  const [videosPerMonth, setVideosPerMonth] = useState(1500);
  const [avgMinutes, setAvgMinutes] = useState(8);
  const [includeMetaProxies, setIncludeMetaProxies] = useState(true);
  const [selectedEngineId, setSelectedEngineId] = useState(COST_ENGINES[0].id);

  const totalMinutes = videosPerMonth * avgMinutes;
  const proxyMonthlyCost = includeMetaProxies
    ? Math.max(35, Math.round(videosPerMonth * 0.012))
    : 0;

  const comparisons = useMemo(() => {
    return COST_ENGINES.map((engine) => {
      const sttCost = totalMinutes * engine.sttPerMinuteUsd;
      const postProcessCost = totalMinutes * engine.llmPostProcessPerMinuteUsd;
      const extractionCompute = totalMinutes * engine.extractionInfraPerMinuteUsd;
      const monthlyTotal =
        sttCost +
        postProcessCost +
        extractionCompute +
        engine.fixedMonthlyOverheadUsd +
        proxyMonthlyCost;
      const effectivePerMinute = totalMinutes > 0 ? monthlyTotal / totalMinutes : 0;
      const turnaroundSeconds = Math.max(
        4,
        Math.round((avgMinutes * 60) / engine.speedMultiplier + 5)
      );

      return {
        engine,
        sttCost,
        postProcessCost,
        extractionCompute,
        monthlyTotal,
        effectivePerMinute,
        turnaroundSeconds,
      };
    });
  }, [totalMinutes, avgMinutes, proxyMonthlyCost]);

  const activeComparison =
    comparisons.find((c) => c.engine.id === selectedEngineId) ?? comparisons[0];

  const lowestCostId = useMemo(() => {
    return comparisons.reduce((best, curr) =>
      curr.monthlyTotal < best.monthlyTotal ? curr : best
    ).engine.id;
  }, [comparisons]);

  return (
    <div className="space-y-8">
      <div className="border-b border-[#E2E8F0] pb-6">
        <h1 className="text-2xl font-bold tracking-tight text-[#0F172A] sm:text-3xl">
          Transcription infrastructure cost &amp; latency estimator
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#475569]">
          Model unit economics across Gemini Multimodal, managed Speech-to-Text APIs, and self-hosted WhisperX GPU workers before committing to an infrastructure stack.
        </p>
      </div>

      <section
        aria-label="Workload parameters"
        className="grid grid-cols-1 gap-6 rounded-xl border border-[#E2E8F0] bg-white p-6 lg:grid-cols-12"
      >
        <div className="space-y-5 lg:col-span-7">
          <div>
            <div className="flex items-baseline justify-between">
              <label htmlFor="videos-slider" className="text-sm font-medium text-[#0F172A]">
                Videos transcribed per month
              </label>
              <span className="font-mono text-sm font-semibold tabular-nums text-[#0F172A]">
                {videosPerMonth.toLocaleString()} videos
              </span>
            </div>
            <input
              id="videos-slider"
              type="range"
              min={50}
              max={25000}
              step={50}
              value={videosPerMonth}
              onChange={(e) => setVideosPerMonth(Number(e.target.value))}
              className="mt-2.5 h-2 w-full cursor-pointer accent-[#E11D48]"
            />
            <div className="mt-1 flex justify-between font-mono text-[11px] tabular-nums text-[#64748B]">
              <span>50</span>
              <span>5,000</span>
              <span>15,000</span>
              <span>25,000</span>
            </div>
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <label htmlFor="duration-slider" className="text-sm font-medium text-[#0F172A]">
                Average video duration
              </label>
              <span className="font-mono text-sm font-semibold tabular-nums text-[#0F172A]">
                {avgMinutes} min
              </span>
            </div>
            <input
              id="duration-slider"
              type="range"
              min={1}
              max={60}
              step={1}
              value={avgMinutes}
              onChange={(e) => setAvgMinutes(Number(e.target.value))}
              className="mt-2.5 h-2 w-full cursor-pointer accent-[#E11D48]"
            />
            <div className="mt-1 flex justify-between font-mono text-[11px] tabular-nums text-[#64748B]">
              <span>1 min (Reels / Shorts)</span>
              <span>15 min (YouTube)</span>
              <span>60 min (Podcasts)</span>
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-[#F1F5F9] pt-4">
            <div>
              <p className="text-sm font-medium text-[#0F172A]">
                Include FB &amp; IG residential proxy pool
              </p>
              <p className="text-xs text-[#64748B]">
                Adds rotating residential egress bandwidth for server-side Meta extraction workers
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={includeMetaProxies}
              onClick={() => setIncludeMetaProxies((prev) => !prev)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                includeMetaProxies ? 'bg-[#0F172A]' : 'bg-[#CBD5E1]'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  includeMetaProxies ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        </div>

        <div className="flex flex-col justify-between rounded-xl border border-[#0F172A] bg-[#0F172A] p-5 text-white lg:col-span-5">
          <div>
            <p className="text-xs text-slate-300">Selected Architecture</p>
            <h2 className="mt-1 text-base font-semibold text-white">
              {activeComparison.engine.name}
            </h2>
            <p className="mt-4 font-mono text-3xl font-semibold tabular-nums text-white">
              ${activeComparison.monthlyTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              <span className="ml-1.5 text-sm font-normal text-slate-400">/ month</span>
            </p>
            <p className="mt-1 font-mono text-xs tabular-nums text-slate-300">
              {totalMinutes.toLocaleString()} audio mins · $
              {activeComparison.effectivePerMinute.toFixed(4)} / min · ~
              {activeComparison.turnaroundSeconds}s per video
            </p>
          </div>

          <dl className="mt-5 space-y-2 border-t border-slate-800 pt-4 text-xs">
            <div className="flex justify-between">
              <dt className="text-slate-400">STT &amp; Diarization</dt>
              <dd className="font-mono tabular-nums text-white">
                ${activeComparison.sttCost.toFixed(2)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">LLM Chapters &amp; Summary</dt>
              <dd className="font-mono tabular-nums text-white">
                ${activeComparison.postProcessCost.toFixed(2)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Extraction Workers &amp; Fixed Hosting</dt>
              <dd className="font-mono tabular-nums text-white">
                ${(activeComparison.extractionCompute + activeComparison.engine.fixedMonthlyOverheadUsd).toFixed(2)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Residential Proxies (FB / IG)</dt>
              <dd className="font-mono tabular-nums text-white">
                ${proxyMonthlyCost.toFixed(2)}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section
        aria-label="Engine cost comparison table"
        className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white"
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-xs font-semibold text-[#475569]">
                <th className="px-5 py-3.5">Transcription Engine</th>
                <th className="px-4 py-3.5 text-right">Monthly Total</th>
                <th className="px-4 py-3.5 text-right">Effective / Min</th>
                <th className="px-4 py-3.5 text-right">Est. Turnaround</th>
                <th className="px-5 py-3.5">Best Fit &amp; Trade-off</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1F5F9]">
              {comparisons.map((row) => {
                const isSelected = row.engine.id === selectedEngineId;
                const isLowest = row.engine.id === lowestCostId;
                return (
                  <tr
                    key={row.engine.id}
                    onClick={() => setSelectedEngineId(row.engine.id)}
                    className={`transition-colors cursor-pointer ${
                      isSelected ? 'bg-[#FFF1F2]/60' : 'hover:bg-[#F8FAFC]'
                    }`}
                  >
                    <td className="px-5 py-4 align-top">
                      <div className="font-semibold text-[#0F172A]">{row.engine.name}</div>
                      <div className="mt-0.5 text-xs text-[#64748B]">{row.engine.tagline}</div>
                      {isLowest && (
                        <div className="mt-1 text-xs font-medium text-[#15803D]">
                          Lowest total cost at current volume
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-4 text-right align-top font-mono font-semibold tabular-nums text-[#0F172A]">
                      ${row.monthlyTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </td>
                    <td className="px-4 py-4 text-right align-top font-mono text-xs tabular-nums text-[#334155]">
                      ${row.effectivePerMinute.toFixed(4)}
                    </td>
                    <td className="px-4 py-4 text-right align-top font-mono text-xs tabular-nums text-[#334155]">
                      ~{row.turnaroundSeconds}s
                    </td>
                    <td className="px-5 py-4 align-top text-xs leading-relaxed text-[#475569]">
                      <p className="text-[#0F172A]">{row.engine.bestFor}</p>
                      <p className="mt-1 text-[#64748B]">Trade-off: {row.engine.tradeoff}</p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
