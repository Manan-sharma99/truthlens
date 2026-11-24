"use client";

import { useState } from "react";
import type {
  AppValidationResult,
  EvalCase,
  EvalMode,
  EvalRunResult,
  EvalSplit,
  PromptIterationEntry,
  PromptVersion,
} from "@/lib/types";

interface EvaluationSectionProps {
  evalRuns: EvalRunResult[];
  benchmarkCases: EvalCase[];
  appValidationResults: AppValidationResult[];
  promptIterations: PromptIterationEntry[];
  onEvalCompleted: () => void;
  onInspectRunInWorkflow: (runId: string) => void;
}

function escapeCsv(val: string | number | boolean): string {
  const s = String(val ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function downloadCsv(filename: string, headers: string[], rows: Array<Array<string | number | boolean>>) {
  const lines = [
    headers.map(escapeCsv).join(","),
    ...rows.map((r) => r.map(escapeCsv).join(",")),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function EvaluationSection({
  evalRuns,
  benchmarkCases,
  appValidationResults,
  promptIterations,
  onEvalCompleted,
  onInspectRunInWorkflow,
}: EvaluationSectionProps) {
  const [version, setVersion] = useState<PromptVersion | "ALL">("ALL");
  const [evalMode, setEvalMode] = useState<EvalMode | "all">("all");
  const [splitFilter, setSplitFilter] = useState<EvalSplit | "all">("all");
  const [running, setRunning] = useState(false);
  const [runningAppVal, setRunningAppVal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const devCases = benchmarkCases.filter((c) => c.split === "development");
  const heldOutCases = benchmarkCases.filter((c) => c.split === "held_out");

  async function handleRunEvaluation() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version, evalMode, splitFilter }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Evaluation failed.");
      }
      onEvalCompleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Evaluation failed.");
      onEvalCompleted(); // Refresh any incrementally saved partial results
    } finally {
      setRunning(false);
    }
  }

  async function handleRunAppValidation() {
    setRunningAppVal(true);
    setError(null);
    try {
      const res = await fetch("/api/app-validation", { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "App validation failed.");
      }
      onEvalCompleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "App validation failed.");
    } finally {
      setRunningAppVal(false);
    }
  }

  const latestPerVersion = (["V1", "V2", "V3"] as const)
    .map((v) => evalRuns.find((e) => e.version === v))
    .filter((e): e is EvalRunResult => Boolean(e));

  const allCaseRows = evalRuns.flatMap((ev) =>
    ev.caseResults.map((cr) => ({
      evalId: ev.evalId,
      version: ev.version,
      model: ev.model,
      evalPartial: Boolean(ev.partial),
      ...cr,
    }))
  );

  const hasIncompleteLatest = latestPerVersion.some((e) => e.partial);

  const allFailures = evalRuns.flatMap((e) => e.failures);

  function exportTestTableCsv() {
    const headers = [
      "Test ID",
      "Split",
      "Mode",
      "Category",
      "Prompt Version",
      "Model",
      "Exact Input",
      "Reference Material",
      "Expected Output",
      "Actual Output",
      "Pass/Fail",
      "Citation Validity",
      "Confidence Summary",
      "Observed Issue",
      "Latency (ms)",
      "Tokens",
    ];
    const rows = allCaseRows.map((r) => [
      r.caseId,
      r.split,
      r.evalMode,
      r.category,
      r.version,
      r.model,
      r.claimInput,
      r.referenceSummary,
      r.expectedOutput,
      r.actualOutput,
      r.passed ? "PASS" : "FAIL",
      `${Math.round(r.citationValidityRate * 100)}%`,
      r.confidenceSummary,
      r.observedIssue,
      r.latencyMs,
      r.tokens,
    ]);
    downloadCsv("truthlens_test_results.csv", headers, rows);
  }

  function exportIterationLogCsv() {
    const headers = [
      "Iteration ID",
      "Timestamp",
      "Saved Prompt Version",
      "Target Files",
      "Changes Introduced",
      "Reason for Modification",
      "Observed Failure",
      "Representative Model Outputs",
      "Retest Results",
      "Model Config",
      "Execution Time (ms)",
      "Token Usage",
    ];
    const rows = promptIterations.map((it) => [
      it.iterationId,
      it.timestamp,
      it.savedPromptVersion,
      it.targetFiles.join("; "),
      it.changesIntroduced,
      it.reasonForModification,
      it.observedFailure,
      it.representativeModelOutputs,
      it.retestResults,
      it.modelConfig,
      it.executionTimeMs,
      it.tokenUsage,
    ]);
    downloadCsv("truthlens_prompt_iterations.csv", headers, rows);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#243049] pb-5">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-100">
            Evaluation &amp; Failure Analysis
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Factual benchmark evaluation (
            <strong className="text-slate-200">
              {devCases.length} development
            </strong>{" "}
            /{" "}
            <strong className="text-slate-200">
              {heldOutCases.length} held-out
            </strong>
            ), kept strictly separate from application input-validation tests.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={splitFilter}
            onChange={(e) =>
              setSplitFilter(e.target.value as EvalSplit | "all")
            }
            className="rounded-md border border-[#243049] bg-[#111827] px-3 py-2 text-xs text-slate-200 focus:border-teal-500 focus:outline-none"
          >
            <option value="all">
              All Splits ({benchmarkCases.length})
            </option>
            <option value="development">
              Development ({devCases.length})
            </option>
            <option value="held_out">
              Held-Out ({heldOutCases.length})
            </option>
          </select>

          <select
            value={evalMode}
            onChange={(e) => setEvalMode(e.target.value as EvalMode | "all")}
            className="rounded-md border border-[#243049] bg-[#111827] px-3 py-2 text-xs text-slate-200 focus:border-teal-500 focus:outline-none"
          >
            <option value="all">All Modes</option>
            <option value="atomic">Atomic Claims Only</option>
            <option value="end_to_end">End-to-End Complex</option>
          </select>

          <select
            value={version}
            onChange={(e) =>
              setVersion(e.target.value as PromptVersion | "ALL")
            }
            className="rounded-md border border-[#243049] bg-[#111827] px-3 py-2 text-xs text-slate-200 focus:border-teal-500 focus:outline-none"
          >
            <option value="ALL">Compare V1, V2 &amp; V3</option>
            <option value="V1">V1 Only</option>
            <option value="V2">V2 Only</option>
            <option value="V3">V3 Only</option>
          </select>

          <button
            type="button"
            disabled={running}
            onClick={handleRunEvaluation}
            className="rounded-md bg-teal-600 px-4 py-2 text-xs font-medium text-slate-950 transition hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? "Running Benchmark..." : "Run Live Evaluation"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">
          {error}
        </div>
      )}

      {/* Version Comparison Table */}
      <div className="rounded-lg border border-[#243049] bg-[#111827] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-200">
            Prompt Version Comparison (Latest Recorded Factual Runs)
          </h3>
          {hasIncompleteLatest && (
            <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">
              Includes incomplete evaluation run(s) — metrics reflect completed cases only
            </span>
          )}
        </div>
        {latestPerVersion.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            No benchmark evaluations recorded yet.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[#243049] text-slate-400">
                  <th className="pb-2.5 font-medium">Version</th>
                  <th className="pb-2.5 font-medium">Split</th>
                  <th className="pb-2.5 font-medium">Cases</th>
                  <th className="pb-2.5 font-medium">Overall Acc.</th>
                  <th className="pb-2.5 font-medium">Atomic Acc.</th>
                  <th className="pb-2.5 font-medium">End-to-End Acc.</th>
                  <th className="pb-2.5 font-medium">Citation Validity</th>
                  <th className="pb-2.5 font-medium">Overconfidence</th>
                  <th className="pb-2.5 font-medium">Avg Latency</th>
                  <th className="pb-2.5 font-medium">Tokens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1e293b] text-slate-200">
                {latestPerVersion.map((ev) => (
                  <tr key={ev.evalId}>
                    <td className="py-3 font-mono font-semibold text-teal-300">
                      {ev.version}
                    </td>
                    <td className="py-3 text-slate-400">
                      <span>{ev.splitFilter ?? "all"}</span>
                      {ev.partial && (
                        <span className="ml-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                          INCOMPLETE
                        </span>
                      )}
                    </td>
                    <td className="py-3">{ev.totalCases}</td>
                    <td className="py-3">
                      {Math.round(ev.verdictAccuracy * 100)}%
                    </td>
                    <td className="py-3">
                      {ev.byMode.atomic.totalCases > 0
                        ? `${Math.round(ev.byMode.atomic.verdictAccuracy * 100)}%`
                        : "—"}
                    </td>
                    <td className="py-3">
                      {ev.byMode.end_to_end.totalCases > 0
                        ? `${Math.round(ev.byMode.end_to_end.verdictAccuracy * 100)}%`
                        : "—"}
                    </td>
                    <td className="py-3 text-teal-300">
                      {Math.round(ev.citationValidityRate * 100)}%
                    </td>
                    <td className="py-3 text-amber-300">
                      {Math.round(ev.overconfidenceRate * 100)}%
                    </td>
                    <td className="py-3">{ev.avgLatencyMs}ms</td>
                    <td className="py-3">{ev.totalTokens}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Complete Test Table + CSV Export */}
      <div className="rounded-lg border border-[#243049] bg-[#111827] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-200">
              Complete Test Table ({allCaseRows.length} Recorded Case Results)
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">
              All benchmark labels are marked{" "}
              <span className="text-amber-300">PROVISIONAL</span> until manually
              reviewed.
            </p>
          </div>
          <button
            type="button"
            disabled={allCaseRows.length === 0}
            onClick={exportTestTableCsv}
            className="rounded border border-[#243049] bg-[#131b2e] px-3 py-1.5 text-xs text-teal-300 hover:border-teal-500/40 disabled:opacity-40"
          >
            Export Test Table CSV
          </button>
        </div>

        {allCaseRows.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            Run an evaluation to populate case-level results.
          </p>
        ) : (
          <div className="mt-4 max-h-96 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-[#111827]">
                <tr className="border-b border-[#243049] text-slate-400">
                  <th className="pb-2 pr-3 font-medium">ID</th>
                  <th className="pb-2 pr-3 font-medium">Split</th>
                  <th className="pb-2 pr-3 font-medium">Category</th>
                  <th className="pb-2 pr-3 font-medium">Ver.</th>
                  <th className="pb-2 pr-3 font-medium">Expected</th>
                  <th className="pb-2 pr-3 font-medium">Actual</th>
                  <th className="pb-2 pr-3 font-medium">Status</th>
                  <th className="pb-2 pr-3 font-medium">Observed Issue</th>
                  <th className="pb-2 font-medium">Trace</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1e293b] text-slate-300">
                {allCaseRows.slice(0, 60).map((r, idx) => (
                  <tr key={`${r.runId}-${idx}`}>
                    <td className="py-2 pr-3 font-mono text-slate-200">
                      {r.caseId}
                    </td>
                    <td className="py-2 pr-3 text-[11px] text-slate-400">
                      {r.split}
                      {r.evalPartial && (
                        <span className="ml-1 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] text-amber-300">
                          partial
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3">{r.category}</td>
                    <td className="py-2 pr-3 font-mono text-teal-300">
                      {r.version}
                    </td>
                    <td className="py-2 pr-3 max-w-[180px] truncate" title={r.expectedOutput}>
                      {r.expectedOutput}
                    </td>
                    <td className="py-2 pr-3 max-w-[200px] truncate" title={r.actualOutput}>
                      {r.actualOutput}
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          r.passed
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-rose-500/15 text-rose-300"
                        }`}
                      >
                        {r.passed ? "PASS" : "FAIL"}
                      </span>
                    </td>
                    <td className="py-2 pr-3 max-w-[180px] truncate text-slate-400" title={r.observedIssue}>
                      {r.observedIssue}
                    </td>
                    <td className="py-2">
                      <button
                        type="button"
                        onClick={() => onInspectRunInWorkflow(r.runId)}
                        className="text-teal-400 hover:text-teal-300"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Separate Application Validation Tests */}
      <div className="rounded-lg border border-[#243049] bg-[#111827] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-200">
              Application Input Validation Tests (Separated from Factual Metrics)
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">
              Verifies deterministic rejection of empty claims, empty reference
              sources, and corrupt/empty uploaded files.
            </p>
          </div>
          <button
            type="button"
            disabled={runningAppVal}
            onClick={handleRunAppValidation}
            className="rounded border border-[#243049] bg-[#131b2e] px-3 py-1.5 text-xs text-teal-300 hover:border-teal-500/40 disabled:opacity-50"
          >
            {runningAppVal ? "Running..." : "Run Validation Tests"}
          </button>
        </div>

        {appValidationResults.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            Click &ldquo;Run Validation Tests&rdquo; to execute the application
            validation suite.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[#243049] text-slate-400">
                  <th className="pb-2 pr-3 font-medium">ID</th>
                  <th className="pb-2 pr-3 font-medium">Category</th>
                  <th className="pb-2 pr-3 font-medium">Input</th>
                  <th className="pb-2 pr-3 font-medium">Expected</th>
                  <th className="pb-2 pr-3 font-medium">Actual</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1e293b] text-slate-300">
                {appValidationResults.map((av) => (
                  <tr key={av.testId}>
                    <td className="py-2 pr-3 font-mono">{av.testId}</td>
                    <td className="py-2 pr-3">{av.category}</td>
                    <td className="py-2 pr-3 text-slate-400">
                      {av.inputSummary}
                    </td>
                    <td className="py-2 pr-3">{av.expectedBehavior}</td>
                    <td className="py-2 pr-3 text-slate-400">
                      {av.actualBehavior}
                    </td>
                    <td className="py-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          av.passed
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-rose-500/15 text-rose-300"
                        }`}
                      >
                        {av.passed ? "PASS" : "FAIL"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Prompt Iteration Log + CSV Export */}
      <div className="rounded-lg border border-[#243049] bg-[#111827] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-200">
            Prompt Iteration Log ({promptIterations.length})
          </h3>
          <button
            type="button"
            disabled={promptIterations.length === 0}
            onClick={exportIterationLogCsv}
            className="rounded border border-[#243049] bg-[#131b2e] px-3 py-1.5 text-xs text-teal-300 hover:border-teal-500/40 disabled:opacity-40"
          >
            Export Iteration Log CSV
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {promptIterations.map((it) => (
            <div
              key={it.iterationId}
              className="rounded border border-[#1e293b] bg-[#090e1a] p-4 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1e293b] pb-2">
                <span className="font-mono font-semibold text-teal-300">
                  {it.iterationId} — {it.savedPromptVersion}
                </span>
                <span className="text-slate-500">
                  {it.modelConfig} · {it.executionTimeMs}ms · {it.tokenUsage} tok
                </span>
              </div>
              <div className="mt-2.5 grid grid-cols-1 gap-2 md:grid-cols-2">
                <div>
                  <strong className="text-slate-300">Observed Failure:</strong>{" "}
                  <span className="text-rose-200/90">{it.observedFailure}</span>
                </div>
                <div>
                  <strong className="text-slate-300">
                    Reason for Modification:
                  </strong>{" "}
                  <span className="text-slate-400">
                    {it.reasonForModification}
                  </span>
                </div>
                <div>
                  <strong className="text-slate-300">
                    Changes Introduced:
                  </strong>{" "}
                  <span className="text-slate-400">
                    {it.changesIntroduced}
                  </span>
                </div>
                <div>
                  <strong className="text-slate-300">Retest Results:</strong>{" "}
                  <span className="text-teal-200">{it.retestResults}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Failure Analysis */}
      <div className="rounded-lg border border-[#243049] bg-[#111827] p-5">
        <h3 className="text-sm font-semibold text-slate-200">
          Observed Failure Analysis ({allFailures.length})
        </h3>
        {allFailures.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            No failures recorded in the stored evaluation runs.
          </p>
        ) : (
          <div className="mt-4 space-y-2.5">
            {allFailures.slice(0, 25).map((f, idx) => (
              <div
                key={idx}
                className="rounded border border-rose-500/25 bg-[#090e1a] p-3 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-[#1e293b] px-1.5 py-0.5 font-mono text-[11px] text-teal-300">
                      {f.version}
                    </span>
                    <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[11px] font-medium text-rose-300">
                      {f.failureType}
                    </span>
                    <span className="font-medium text-slate-200">
                      {f.caseTitle}
                    </span>
                  </div>
                  <span className="font-mono text-[10px] text-slate-500">
                    {f.split} · {f.evalMode}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="text-slate-400">
                    <strong>Expected:</strong> {f.expected}
                  </div>
                  <div className="text-rose-200">
                    <strong>Actual:</strong> {f.actual}
                  </div>
                </div>
                <p className="mt-1.5 text-slate-400">{f.details}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
