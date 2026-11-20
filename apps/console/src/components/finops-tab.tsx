'use client';

import { BarChart3, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { routeEconomics } from '@/lib/finops';
import { fmtInt, fmtPct, fmtUsd } from '@/lib/format';
import { PLATFORM_FIXED_MONTHLY_USD, PRICING_MODELS, projectPricing, BUDGET_UTILIZATION, type PricingModel } from '@/lib/pricing';
import type { ProjectView } from '@/lib/types';
import { Badge, Card, Kpi, cn } from './ui';
import { WaterfallChart } from './waterfall-chart';

export function FinOpsTab({ project }: { project: ProjectView }) {
  const [price, setPrice] = useState(Number(project.creditUnitPriceUsd) || 0.001);
  const [model, setModel] = useState<PricingModel>('payg');
  const [tenants, setTenants] = useState(100);

  useEffect(() => setPrice(Number(project.creditUnitPriceUsd) || 0.001), [project.slug, project.creditUnitPriceUsd]);

  const routes = useMemo(() => routeEconomics(project, price), [project, price]);
  const projection = useMemo(() => projectPricing(project, { creditPriceUsd: price, model, tenants }), [project, price, model, tenants]);

  return (
    <div className="space-y-6">
      <Card
        icon={<BarChart3 className="h-4 w-4" />}
        title="Unit economics per route"
        subtitle={`Billed credits × ${fmtUsd(price, 4)}/credit vs estimated cloud cost (base ${fmtUsd(Number(project.infraCostPerReqUsd), 6)}/req × route compute profile)`}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-slate-500">
              <tr className="border-b border-slate-800">
                <th className="py-2 pr-4 font-medium">Route</th>
                <th className="py-2 pr-4 text-right font-medium">Requests</th>
                <th className="py-2 pr-4 text-right font-medium">Blocked % (saved spend)</th>
                <th className="py-2 pr-4 text-right font-medium">Billed credits</th>
                <th className="py-2 pr-4 text-right font-medium">Gross revenue</th>
                <th className="py-2 pr-4 text-right font-medium">Est. infra cost</th>
                <th className="py-2 text-right font-medium">Net gross margin</th>
              </tr>
            </thead>
            <tbody className="font-mono text-[13px]">
              {routes.map((r) => (
                <tr key={r.route} className="border-b border-slate-800/60">
                  <td className="py-2.5 pr-4">
                    <div className="text-cyan-200">{r.route}</div>
                    <div className="font-sans text-[11px] text-slate-500">{r.profile}</div>
                  </td>
                  <td className="py-2.5 pr-4 text-right text-slate-200">{fmtInt(r.totalRequests)}</td>
                  <td className="py-2.5 pr-4 text-right text-slate-300">
                    {fmtPct(r.blockedPct)} <span className="text-violet-300">({fmtUsd(r.savedSpendUsd, 4)})</span>
                  </td>
                  <td className="py-2.5 pr-4 text-right text-amber-200">{fmtInt(r.creditsConsumed)}</td>
                  <td className="py-2.5 pr-4 text-right text-emerald-300">{fmtUsd(r.revenueUsd, 4)}</td>
                  <td className="py-2.5 pr-4 text-right text-rose-300">{fmtUsd(r.infraCostUsd, 4)}</td>
                  <td className="py-2.5 text-right">
                    {r.marginPct < 0 ? (
                      <Badge tone="red">
                        <TriangleAlert className="h-3 w-3" /> {fmtPct(r.marginPct)} reprice
                      </Badge>
                    ) : (
                      <span className={cn(r.marginPct < 30 ? 'text-amber-300' : 'text-emerald-300')}>{fmtPct(r.marginPct)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {routes.length === 0 && <p className="py-4 text-sm text-slate-500">No usage recorded yet. Fire traffic in the Chaos Lab, then settle the buffer.</p>}
        </div>
      </Card>

      <Card icon={<SlidersHorizontal className="h-4 w-4" />} title="SaaS pricing strategy sandbox" subtitle={`Projects ${fmtInt(tenants)} tenants shaped like ${project.name}'s observed traffic mix`}>
        <div className="grid gap-6 lg:grid-cols-3">
          <label className="block">
            <div className="flex justify-between text-[11px] font-medium uppercase tracking-wider text-slate-400">
              <span>Credit unit price</span>
              <span className="font-mono text-cyan-200">{fmtUsd(price, 4)}</span>
            </div>
            <input className="mt-3 w-full" type="range" min={0.0005} max={0.01} step={0.0005} value={price} onChange={(e) => setPrice(Number(e.target.value))} />
            <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-600">
              <span>$0.0005</span>
              <span>$0.0100</span>
            </div>
          </label>
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Pricing model</div>
            <div className="mt-2 grid gap-1.5">
              {PRICING_MODELS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setModel(m.id)}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-left text-xs transition',
                    m.id === model ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-100' : 'border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700',
                  )}
                >
                  <div className="font-medium">{m.label}</div>
                  <div className="text-[11px] opacity-70">{m.detail}</div>
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <div className="flex justify-between text-[11px] font-medium uppercase tracking-wider text-slate-400">
              <span>Monthly active API consumers</span>
              <span className="font-mono text-cyan-200">{fmtInt(tenants)}</span>
            </div>
            <input className="mt-3 w-full" type="range" min={10} max={1000} step={10} value={tenants} onChange={(e) => setTenants(Number(e.target.value))} />
            <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-600">
              <span>10</span>
              <span>1,000 tenants</span>
            </div>
          </label>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Kpi label="MRR" value={fmtUsd(projection.mrr, 0)} tone="green" hint={`${fmtUsd(projection.revenuePerTenant)} / tenant`} />
          <Kpi label="ARR" value={fmtUsd(projection.arr, 0)} tone="green" />
          <Kpi label="Cloud infra COGS" value={fmtUsd(projection.cogs, 0)} tone="red" />
          <Kpi label="DDoS cost savings" value={fmtUsd(projection.ddosSavings, 0)} tone="violet" hint="upstream spend avoided by 429s" />
          <Kpi label="Net operating margin" value={fmtPct(projection.netMarginPct)} tone={projection.netMarginPct >= 0 ? 'cyan' : 'red'} hint={fmtUsd(projection.netProfit, 0)} />
        </div>

        <div className="mt-6 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
          <WaterfallChart
            steps={[
              { label: 'Gross MRR', value: projection.mrr, kind: 'total' },
              { label: 'Infra COGS', value: -projection.cogs, kind: 'delta' },
              { label: 'Platform fixed', value: -projection.platformFixed, kind: 'delta' },
              { label: 'Net profit', value: projection.netProfit, kind: 'result' },
              { label: 'DDoS savings', value: projection.ddosSavings, kind: 'ghost' },
            ]}
          />
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          Assumptions: each tenant consumes {fmtPct(BUDGET_UTILIZATION * 100, 0)} of a {fmtInt(project.monthlyBudgetCredits)}-credit monthly budget (
          {fmtInt(projection.creditsPerTenant)} credits) with this project’s observed credits/request and block ratio; platform fixed cost{' '}
          {fmtUsd(PLATFORM_FIXED_MONTHLY_USD, 0)}/mo. Route compute profiles are estimates (e.g. GPU inference ≈ 800× base cost).
        </p>
      </Card>
    </div>
  );
}
