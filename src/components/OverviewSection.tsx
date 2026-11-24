"use client";

import type { EvalRunResult, VerificationRun, Verdict } from "@/lib/types";
import { VerdictBadge } from "./VerdictBadge";

interface OverviewSectionProps {
  verificationRuns: VerificationRun[];
  evalRuns: EvalRunResult[];
  apiConfigured: boolean | null;
  modelName: string;
  onNavigate: (tab: "verify" | "workflow" | "evaluation") => void;
}

export function OverviewSection({
  verificationRuns,
  evalRuns,
  apiConfigured,
  modelName,
  onNavigate,
}: OverviewSectionProps) {
  const totalRuns = verificationRuns.length;
  const allClaims = verificationRuns.flatMap((r) => r.claims);
  const totalClaims = allClaims.length;

  const totalCitations = verificationRuns.reduce(
    (s, r) => s + r.metrics.totalCitations,
    0
  );
  const verifiedCitations = verificationRuns.reduce(
    (s, r) => s + r.metrics.verifiedCitations,
    0
  );
  const citationValidityPct =
    totalCitations === 0
      ? "—"
      : `${Math.round((verifiedCitations / totalCitations) * 100)}%`;

  const verdictCounts: Record<Verdict, number> = {
    Supported: 0,
    Contradicted: 0,
    "Insufficient Evidence": 0,
    "Conflicting Evidence": 0,
  };
  for (const c of allClaims) {
    verdictCounts[c.verdict] += 1;
  }

  const latestByVersion = (["V1", "V2", "V3"] as const).map((v) => {
    const latestEval = evalRuns.find((e) => e.version === v);
    const versionRuns = verificationRuns.filter((r) => r.version === v);
    return { version: v, latestEval, runCount: versionRuns.length };
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#243049] pb-5">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-100">
            Overview
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Verification statistics and prompt performance computed strictly from
            persisted model runs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onNavigate("verify")}
            className="rounded-md bg-teal-600 px-3.5 py-2 text-xs font-medium text-slate-950 transition hover:bg-teal-500"
          >
            New Verification
          </button>
          <button
            onClick={() => onNavigate("evaluation")}
            className="rounded-md border border-[#243049] bg-[#131b2e] px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:border-teal-500/40"
          >
            Run Evaluation
          </button>
        </div>
      </div>

      {apiConfigured === false && (
        <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 p-4 text-sm text-amber-200">
          <span className="font-semibold">API Key Not Configured:</span> Add{" "}
          <code className="rounded bg-black/30 px-1.5 py-0.5 text-xs">
            GEMINI_API_KEY
          </code>{" "}
          to <code className="rounded bg-black/30 px-1.5 py-0.5 text-xs">.env.local</code>{" "}
          and restart the server to execute live verifications and evaluations.
        </div>
      )}

      {/* Top KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-[#243049] bg-[#111827] p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-slate-400">
            Verification Runs
          </div>
          <div className="mt-2 text-2xl font-semibold text-slate-100">
            {totalRuns}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Model: {modelName || "Not set"}
          </div>
        </div>

        <div className="rounded-lg border border-[#243049] bg-[#111827] p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-slate-400">
            Claims Evaluated
          </div>
          <div className="mt-2 text-2xl font-semibold text-slate-100">
            {totalClaims}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Across all prompt versions
          </div>
        </div>

        <div className="rounded-lg border border-[#243049] bg-[#111827] p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-slate-400">
            Verbatim Citation Validity
          </div>
          <div className="mt-2 text-2xl font-semibold text-teal-300">
            {citationValidityPct}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {verifiedCitations} / {totalCitations} quotes verified
          </div>
        </div>

        <div className="rounded-lg border border-[#243049] bg-[#111827] p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-slate-400">
            Evaluation Runs
          </div>
          <div className="mt-2 text-2xl font-semibold text-slate-100">
            {evalRuns.length}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Recorded benchmark suites
          </div>
        </div>
      </div>

      {/* Verdict Distribution + Version Summary */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-[#243049] bg-[#111827] p-5">
          <h3 className="text-sm font-semibold text-slate-200">
            Verdict Distribution (Actual Runs)
          </h3>
          {totalClaims === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              No claims verified yet. Run a verification or benchmark evaluation
              to populate real verdict statistics.
            </p>
          ) : (
            <div className="mt-4 space-y-3">
              {(Object.keys(verdictCounts) as Verdict[]).map((v) => {
                const count = verdictCounts[v];
                const pct = Math.round((count / totalClaims) * 100);
                return (
                  <div key={v} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <VerdictBadge verdict={v} />
                      <span className="text-slate-400">
                        {count} ({pct}%)
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#1e293b]">
                      <div
                        className="h-full bg-teal-400/70"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-[#243049] bg-[#111827] p-5">
          <h3 className="text-sm font-semibold text-slate-200">
            Prompt Version Snapshot
          </h3>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[#243049] text-slate-400">
                  <th className="pb-2 font-medium">Version</th>
                  <th className="pb-2 font-medium">Runs</th>
                  <th className="pb-2 font-medium">Latest Eval Acc.</th>
                  <th className="pb-2 font-medium">Citation Validity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1e293b]">
                {latestByVersion.map(({ version, latestEval, runCount }) => (
                  <tr key={version} className="text-slate-300">
                    <td className="py-2.5 font-medium text-teal-300">
                      {version}
                    </td>
                    <td className="py-2.5">{runCount}</td>
                    <td className="py-2.5">
                      {latestEval ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span>
                            {Math.round(latestEval.verdictAccuracy * 100)}%
                          </span>
                          {latestEval.partial && (
                            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                              INCOMPLETE ({latestEval.totalCases})
                            </span>
                          )}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2.5">
                      {latestEval
                        ? `${Math.round(latestEval.citationValidityRate * 100)}%`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Recent Verification Runs */}
      <div className="rounded-lg border border-[#243049] bg-[#111827] p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200">
            Recent Verification Runs
          </h3>
          <button
            onClick={() => onNavigate("workflow")}
            className="text-xs text-teal-400 hover:text-teal-300"
          >
            Inspect Prompt Stages →
          </button>
        </div>
        {verificationRuns.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            No verification history recorded yet.
          </p>
        ) : (
          <div className="mt-4 divide-y divide-[#1e293b]">
            {verificationRuns.slice(0, 6).map((run) => (
              <div
                key={run.runId}
                className="flex flex-wrap items-center justify-between gap-3 py-3 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-[#1e293b] px-1.5 py-0.5 font-mono text-[11px] text-teal-300">
                      {run.version}
                    </span>
                    <span className="truncate font-medium text-slate-200">
                      {run.claimInput}
                    </span>
                  </div>
                  <div className="mt-1 text-slate-500">
                    {new Date(run.createdAt).toLocaleString()} ·{" "}
                    {run.claims.length} claim(s) · {run.metrics.totalLatencyMs}ms
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {run.claims.slice(0, 3).map((c) => (
                    <VerdictBadge key={c.claimId} verdict={c.verdict} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
