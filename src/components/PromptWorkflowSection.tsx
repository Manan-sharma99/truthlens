"use client";

import { useState } from "react";
import { downloadJson } from "@/lib/download";
import type { PromptTemplate, VerificationRun } from "@/lib/types";

interface PromptWorkflowSectionProps {
  templates: PromptTemplate[];
  runs: VerificationRun[];
  sessionRunIds: Set<string>;
  selectedRunId: string | null;
  onSelectRunId: (runId: string) => void;
}

export function PromptWorkflowSection({
  templates,
  runs,
  sessionRunIds,
  selectedRunId,
  onSelectRunId,
}: PromptWorkflowSectionProps) {
  const [mode, setMode] = useState<"templates" | "traces">(
    selectedRunId ? "traces" : "templates"
  );
  const [versionFilter, setVersionFilter] = useState<"ALL" | "V1" | "V2" | "V3">(
    "V3"
  );

  const filteredTemplates =
    versionFilter === "ALL"
      ? templates
      : templates.filter((t) => t.version === versionFilter);

  const activeRun =
    runs.find((r) => r.runId === selectedRunId) ?? runs[0] ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#243049] pb-5">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-100">
            Prompt Workflow
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Inspect external prompt templates stored in{" "}
            <code className="rounded bg-[#131b2e] px-1.5 py-0.5 text-xs text-teal-300">
              /prompts
            </code>{" "}
            and examine stage-by-stage model inputs, temperatures, and raw
            outputs from live session and historical runs.
          </p>
        </div>

        <div className="flex rounded-md border border-[#243049] bg-[#111827] p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setMode("templates")}
            className={`rounded px-3 py-1.5 font-medium transition ${
              mode === "templates"
                ? "bg-teal-500/20 text-teal-200"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Prompt Templates
          </button>
          <button
            type="button"
            onClick={() => setMode("traces")}
            className={`rounded px-3 py-1.5 font-medium transition ${
              mode === "traces"
                ? "bg-teal-500/20 text-teal-200"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Run Stage Outputs ({runs.length})
          </button>
        </div>
      </div>

      {mode === "templates" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            {(["V3", "V2", "V1", "ALL"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setVersionFilter(v)}
                className={`rounded border px-3 py-1 text-xs font-medium ${
                  versionFilter === v
                    ? "border-teal-400 bg-teal-500/15 text-teal-200"
                    : "border-[#243049] bg-[#111827] text-slate-400 hover:text-slate-200"
                }`}
              >
                {v}
              </button>
            ))}
          </div>

          <div className="space-y-4">
            {filteredTemplates.map((tpl) => (
              <div
                key={tpl.id}
                className="rounded-lg border border-[#243049] bg-[#111827] p-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1e293b] pb-3">
                  <div className="flex items-center gap-2.5">
                    <span className="rounded bg-teal-500/15 px-2 py-0.5 font-mono text-xs font-semibold text-teal-300">
                      {tpl.version}
                    </span>
                    <h3 className="text-sm font-semibold text-slate-100">
                      {tpl.stage} — {tpl.name}
                    </h3>
                  </div>
                  <div className="flex items-center gap-3 font-mono text-xs text-slate-400">
                    <span>id: {tpl.id}</span>
                    <span>temp: {tpl.temperature}</span>
                  </div>
                </div>
                <p className="mt-2.5 text-xs text-slate-400">
                  {tpl.description}
                </p>

                <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <div>
                    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      System Prompt
                    </div>
                    <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded border border-[#1e293b] bg-[#090e1a] p-3 font-mono text-[11px] leading-relaxed text-slate-300">
                      {tpl.systemPrompt}
                    </pre>
                  </div>
                  <div>
                    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      User Prompt Template
                    </div>
                    <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded border border-[#1e293b] bg-[#090e1a] p-3 font-mono text-[11px] leading-relaxed text-slate-300">
                      {tpl.userTemplate}
                    </pre>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {mode === "traces" && (
        <div className="space-y-4">
          {runs.length === 0 ? (
            <div className="rounded-lg border border-[#243049] bg-[#111827] p-6 text-sm text-slate-400">
              No verification runs recorded yet. Run a verification in{" "}
              <strong className="text-slate-200">Verify Claims</strong> to
              inspect actual stage prompts and generated outputs.
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-[#243049] bg-[#111827] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Select Recorded Run
                  </label>
                  {activeRun && (
                    <button
                      type="button"
                      onClick={() =>
                        downloadJson(
                          `truthlens_trace_${activeRun.version}_${activeRun.runId.slice(0, 8)}.json`,
                          activeRun
                        )
                      }
                      className="rounded border border-[#243049] bg-[#131b2e] px-2.5 py-1 text-xs text-teal-300 hover:border-teal-500/40"
                    >
                      Download Complete Trace (JSON)
                    </button>
                  )}
                </div>
                <select
                  value={activeRun?.runId ?? ""}
                  onChange={(e) => onSelectRunId(e.target.value)}
                  className="mt-2 w-full rounded border border-[#243049] bg-[#090e1a] p-2 text-xs text-slate-200 focus:border-teal-500 focus:outline-none"
                >
                  {runs.map((r) => {
                    const tag = sessionRunIds.has(r.runId)
                      ? "LIVE SESSION"
                      : "HISTORICAL";
                    return (
                      <option key={r.runId} value={r.runId}>
                        [{tag}] [{r.version}]{" "}
                        {new Date(r.createdAt).toLocaleString()} —{" "}
                        {r.claimInput.slice(0, 75)}
                      </option>
                    );
                  })}
                </select>
              </div>

              {activeRun && (
                <div className="space-y-4">
                  <div className="rounded-lg border border-[#243049] bg-[#111827] p-4 text-xs text-slate-300">
                    <div className="flex flex-wrap items-center gap-4">
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                          sessionRunIds.has(activeRun.runId)
                            ? "bg-teal-500/20 text-teal-300"
                            : "bg-slate-700/40 text-slate-400"
                        }`}
                      >
                        {sessionRunIds.has(activeRun.runId)
                          ? "LIVE SESSION"
                          : "HISTORICAL RECORD"}
                      </span>
                      <span>
                        <strong>Version:</strong> {activeRun.version}
                      </span>
                      <span>
                        <strong>Model:</strong> {activeRun.modelConfig.model}
                      </span>
                      <span>
                        <strong>Stages Executed:</strong>{" "}
                        {activeRun.stages.length}
                      </span>
                      <span>
                        <strong>Total Latency:</strong>{" "}
                        {activeRun.metrics.totalLatencyMs}ms
                      </span>
                      <span>
                        <strong>Tokens:</strong>{" "}
                        {activeRun.metrics.totalInputTokens} in /{" "}
                        {activeRun.metrics.totalOutputTokens} out
                      </span>
                    </div>
                  </div>

                  {activeRun.stages.map((stage, idx) => (
                    <div
                      key={`${stage.stageId}-${idx}`}
                      className="rounded-lg border border-[#243049] bg-[#111827] p-5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1e293b] pb-3">
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-semibold text-teal-300">
                            {stage.stageName}
                          </h3>
                          <span className="rounded bg-[#1e293b] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                            {stage.templateId}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 font-mono text-[11px] text-slate-400">
                          <span>temp: {stage.temperature}</span>
                          <span>{stage.latencyMs}ms</span>
                          <span>
                            {stage.inputTokens}+{stage.outputTokens} tok
                          </span>
                        </div>
                      </div>

                      <details className="mt-3 rounded border border-[#1e293b] bg-[#090e1a] p-2.5 text-xs">
                        <summary className="cursor-pointer font-medium text-slate-400 hover:text-slate-200">
                          View System Prompt ({stage.templateId})
                        </summary>
                        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-slate-300">
                          {stage.systemPrompt}
                        </pre>
                      </details>

                      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
                        <div>
                          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                            Rendered User Prompt
                          </div>
                          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-[#1e293b] bg-[#090e1a] p-3 font-mono text-[11px] text-slate-300">
                            {stage.renderedUserPrompt}
                          </pre>
                        </div>
                        <div>
                          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                            Raw Model Output
                          </div>
                          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-[#1e293b] bg-[#090e1a] p-3 font-mono text-[11px] text-emerald-200/90">
                            {stage.rawOutput}
                          </pre>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
