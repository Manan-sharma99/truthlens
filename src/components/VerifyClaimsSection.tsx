"use client";

import { useState } from "react";
import type { VerifyDraftState } from "@/app/page";
import {
  downloadJson,
  downloadText,
  formatVerificationRunMarkdown,
} from "@/lib/download";
import { ApiRequestError, readApiJson } from "@/lib/http";
import type {
  ReferenceSource,
  StageTrace,
  VerificationRun,
} from "@/lib/types";
import { ConfidenceBadge, VerdictBadge } from "./VerdictBadge";

interface VerifyClaimsSectionProps {
  draft: VerifyDraftState;
  onDraftChange: (
    updater: VerifyDraftState | ((prev: VerifyDraftState) => VerifyDraftState)
  ) => void;
  results: VerificationRun[];
  onClearResults: () => void;
  onAppendResult: (run: VerificationRun) => void;
  onRunCompleted: (runs: VerificationRun[]) => void;
  onInspectRunInWorkflow: (runId: string) => void;
}

const SAMPLE_PRESETS = [
  {
    label: "Compound Financial Claim",
    claim:
      "NovaGrid Energy's revenue rose 40% to $2.8 billion in 2025, and the company announced plans to build three nuclear plants in Ohio.",
    sources: [
      {
        id: "S1",
        title: "NovaGrid 2025 Annual Report",
        type: "text" as const,
        content:
          "NovaGrid Energy reported full-year 2025 revenue of $2.8 billion, representing a 40% increase over 2024 revenue of $2.0 billion. Operating margins improved to 18.4% following grid-storage deployments in Texas and California.",
        charCount: 225,
      },
    ],
  },
  {
    label: "Conflicting Clinical Sources",
    claim:
      "The Phase 2 trial of Compound Z reduced recovery time by 50% with no serious adverse events.",
    sources: [
      {
        id: "S1",
        title: "Sponsor Press Release",
        type: "text" as const,
        content:
          "BioPulse announced that its Phase 2 trial of Compound Z reduced median recovery time by 50% compared to placebo, with no serious adverse events observed.",
        charCount: 154,
      },
      {
        id: "S2",
        title: "Independent Safety Board Addendum",
        type: "text" as const,
        content:
          "An independent Data Safety Monitoring Board review of the Compound Z Phase 2 trial documented 4 serious adverse events (acute hypotension) in the treatment arm and found a 22% reduction in recovery time.",
        charCount: 203,
      },
    ],
  },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasV3Disagreement(
  extractedClaims: Array<{ claimId?: string }>,
  stage3Data: { verifications?: Array<{ claimId?: string; verdict?: string }> },
  stage4Data: {
    independentVerifications?: Array<{ claimId?: string; verdict?: string }>;
  }
): boolean {
  const s3Map = new Map(
    (stage3Data.verifications ?? []).map((v) => [
      v.claimId,
      (v.verdict ?? "").trim().toLowerCase(),
    ])
  );
  const s4Map = new Map(
    (stage4Data.independentVerifications ?? []).map((v) => [
      v.claimId,
      (v.verdict ?? "").trim().toLowerCase(),
    ])
  );
  return extractedClaims.some((ec, idx) => {
    const cid = ec.claimId || `C${idx + 1}`;
    const v3 = s3Map.get(cid) || "insufficient evidence";
    const v4 = s4Map.get(cid) || "insufficient evidence";
    return v3 !== v4;
  });
}

export function VerifyClaimsSection({
  draft,
  onDraftChange,
  results,
  onClearResults,
  onAppendResult,
  onInspectRunInWorkflow,
}: VerifyClaimsSectionProps) {
  const [loading, setLoading] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { claimInput, sources, version } = draft;

  function addTextSource() {
    onDraftChange((prev) => {
      const nextNum = prev.sources.length + 1;
      return {
        ...prev,
        sources: [
          ...prev.sources,
          {
            id: `S${nextNum}`,
            title: `Reference Source ${nextNum}`,
            type: "text",
            content: "",
            charCount: 0,
          },
        ],
      };
    });
  }

  function updateSource(idx: number, patch: Partial<ReferenceSource>) {
    onDraftChange((prev) => ({
      ...prev,
      sources: prev.sources.map((s, i) => {
        if (i !== idx) return s;
        const updated = { ...s, ...patch };
        updated.charCount = updated.content.length;
        return updated;
      }),
    }));
  }

  function removeSource(idx: number) {
    onDraftChange((prev) => ({
      ...prev,
      sources: prev.sources.filter((_, i) => i !== idx),
    }));
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/parse-source", {
        method: "POST",
        body: formData,
      });
      const data = await readApiJson<{
        title: string;
        type: ReferenceSource["type"];
        content: string;
        charCount: number;
      }>(res);
      onDraftChange((prev) => {
        const nextNum = prev.sources.length + 1;
        const newSource: ReferenceSource = {
          id: `S${nextNum}`,
          title: data.title,
          type: data.type,
          content: data.content,
          charCount: data.charCount,
        };
        if (prev.sources.length === 1 && !prev.sources[0].content.trim()) {
          return { ...prev, sources: [{ ...newSource, id: "S1" }] };
        }
        return { ...prev, sources: [...prev.sources, newSource] };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "File upload failed.");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function postJsonWithBackoff<T>(
    url: string,
    payload: unknown,
    stepLabel: string
  ): Promise<T> {
    setProgressLabel(stepLabel);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return await readApiJson<T>(res);
    } catch (err) {
      if (
        err instanceof ApiRequestError &&
        err.status === 429 &&
        err.retryAfterSec !== undefined &&
        err.retryAfterSec > 0 &&
        err.retryAfterSec <= 25
      ) {
        setProgressLabel(
          `Rate limit reached during ${stepLabel} — waiting ${err.retryAfterSec}s before retry...`
        );
        await sleep(err.retryAfterSec * 1000);
        setProgressLabel(`${stepLabel} (retrying)...`);
        const retryRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        return await readApiJson<T>(retryRes);
      }
      throw err;
    }
  }

  async function runSinglePassRemote(v: "V1" | "V2"): Promise<VerificationRun> {
    const data = await postJsonWithBackoff<{ runs?: VerificationRun[] }>(
      "/api/verify",
      { version: v, claimInput, sources },
      `Running ${v}...`
    );
    const run = data.runs?.[0];
    if (!run) {
      throw new Error(`${v} returned an empty verification result.`);
    }
    return run;
  }

  async function runStagedV3Remote(): Promise<VerificationRun> {
    const temperatures: Record<string, number> = {};
    const priorTraces: StageTrace[] = [];

    // Stage 1: Claim Extraction
    const s1 = await postJsonWithBackoff<{
      done: boolean;
      run?: VerificationRun;
      extractedClaims?: Array<{ claimId?: string }>;
      unresolvedClaimEntities?: unknown[];
      trace?: StageTrace;
      templateId?: string;
      temperature?: number;
    }>(
      "/api/verify/v3-step",
      { step: "stage1", claimInput, sources },
      "V3 Stage 1/5: Claim Extraction..."
    );

    if (s1.done && s1.run) {
      return s1.run;
    }
    if (s1.trace) priorTraces.push(s1.trace);
    if (s1.templateId && typeof s1.temperature === "number") {
      temperatures[s1.templateId] = s1.temperature;
    }

    const extractedClaims = s1.extractedClaims ?? [];
    const unresolvedClaimEntities = s1.unresolvedClaimEntities ?? [];

    // Stage 2: Evidence Analysis
    const s2 = await postJsonWithBackoff<{
      stage2Data: unknown;
      trace: StageTrace;
      templateId: string;
      temperature: number;
    }>(
      "/api/verify/v3-step",
      {
        step: "stage2",
        claimInput,
        sources,
        extractedClaims,
        unresolvedClaimEntities,
      },
      "V3 Stage 2/5: Evidence Analysis..."
    );
    priorTraces.push(s2.trace);
    temperatures[s2.templateId] = s2.temperature;

    // Stage 3: Claim Verification
    const s3 = await postJsonWithBackoff<{
      stage3Data: { verifications?: Array<{ claimId?: string; verdict?: string }> };
      trace: StageTrace;
      templateId: string;
      temperature: number;
    }>(
      "/api/verify/v3-step",
      {
        step: "stage3",
        claimInput,
        sources,
        extractedClaims,
        stage2Data: s2.stage2Data,
      },
      "V3 Stage 3/5: Claim Verification..."
    );
    priorTraces.push(s3.trace);
    temperatures[s3.templateId] = s3.temperature;

    // Stage 4: Blind Independent Verification (receives claims + sources ONLY)
    const s4 = await postJsonWithBackoff<{
      stage4Data: {
        independentVerifications?: Array<{ claimId?: string; verdict?: string }>;
      };
      trace: StageTrace;
      templateId: string;
      temperature: number;
    }>(
      "/api/verify/v3-step",
      {
        step: "stage4",
        claimInput,
        sources,
        extractedClaims,
      },
      "V3 Stage 4/5: Blind Independent Verification..."
    );
    priorTraces.push(s4.trace);
    temperatures[s4.templateId] = s4.temperature;

    // Conditional Stage 4b: Disagreement Adjudication ONLY if Stage 3 & Stage 4 disagree
    let stage4bData: unknown = undefined;
    if (hasV3Disagreement(extractedClaims, s3.stage3Data, s4.stage4Data)) {
      const s4b = await postJsonWithBackoff<{
        skipped: boolean;
        stage4bData: unknown;
        trace?: StageTrace;
        templateId?: string;
        temperature?: number;
      }>(
        "/api/verify/v3-step",
        {
          step: "stage4b",
          claimInput,
          sources,
          extractedClaims,
          stage3Data: s3.stage3Data,
          stage4Data: s4.stage4Data,
        },
        "V3 Stage 4b: Disagreement Reviewer..."
      );
      stage4bData = s4b.stage4bData;
      if (!s4b.skipped && s4b.trace) {
        priorTraces.push(s4b.trace);
        if (s4b.templateId && typeof s4b.temperature === "number") {
          temperatures[s4b.templateId] = s4b.temperature;
        }
      }
    }

    // Stage 5: Report Synthesis + Deterministic Citation/Confidence Finalization
    const s5 = await postJsonWithBackoff<{ run: VerificationRun }>(
      "/api/verify/v3-step",
      {
        step: "stage5",
        claimInput,
        sources,
        extractedClaims,
        stage3Data: s3.stage3Data,
        stage4Data: s4.stage4Data,
        stage4bData,
        priorTraces,
        temperatures,
      },
      "V3 Stage 5/5: Report Generation..."
    );

    return s5.run;
  }

  async function handleVerify() {
    setLoading(true);
    setError(null);
    setProgressLabel("");
    // Clear previous run's displayed results immediately so failed runs never show stale outputs
    onClearResults();

    const versionsToRun: Array<"V1" | "V2" | "V3"> =
      version === "ALL" ? ["V1", "V2", "V3"] : [version];
    const failures: string[] = [];

    try {
      for (const v of versionsToRun) {
        try {
          const run =
            v === "V3"
              ? await runStagedV3Remote()
              : await runSinglePassRemote(v);
          onAppendResult(run);
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "Verification failed.";
          failures.push(`${v}: ${msg}`);
          // Fast-fail remaining versions only on missing API key or invalid input
          if (
            err instanceof ApiRequestError &&
            (err.status === 400 || err.code === "MISSING_API_KEY")
          ) {
            break;
          }
        }
      }

      if (failures.length > 0) {
        if (versionsToRun.length > 1 && failures.length < versionsToRun.length) {
          setError(
            `Partial comparison completed (successful version results were preserved). Failures — ${failures.join(" | ")}`
          );
        } else {
          setError(failures.join(" | "));
        }
      }
    } finally {
      setLoading(false);
      setProgressLabel("");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#243049] pb-5">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-100">
            Verify Claims
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Submit statements or AI responses with trusted reference material
            (PDF, TXT, or direct text) for grounded verification.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {SAMPLE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() =>
                onDraftChange((prev) => ({
                  ...prev,
                  claimInput: preset.claim,
                  sources: preset.sources,
                }))
              }
              className="rounded border border-[#243049] bg-[#131b2e] px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-teal-500/40 hover:text-teal-200"
            >
              Load: {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Input Workbench */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Left: Claim + Controls */}
        <div className="space-y-4 rounded-lg border border-[#243049] bg-[#111827] p-5">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300">
              Claim / Statement / AI Response
            </label>
            <textarea
              value={claimInput}
              onChange={(e) =>
                onDraftChange((prev) => ({
                  ...prev,
                  claimInput: e.target.value,
                }))
              }
              rows={6}
              placeholder="Paste a social media post, news claim, or AI-generated paragraph to fact-check..."
              className="mt-2 w-full rounded-md border border-[#243049] bg-[#090e1a] p-3 text-sm text-slate-100 placeholder-slate-500 focus:border-teal-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300">
              Prompt Engineering Version
            </label>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(["V1", "V2", "V3", "ALL"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() =>
                    onDraftChange((prev) => ({ ...prev, version: v }))
                  }
                  className={`rounded-md border px-3 py-2 text-xs font-medium transition ${
                    version === v
                      ? "border-teal-400 bg-teal-500/15 text-teal-200"
                      : "border-[#243049] bg-[#090e1a] text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {v === "ALL" ? "Compare V1–V3" : v}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {version === "V1" && "V1: Basic zero-shot single-pass prompt."}
              {version === "V2" &&
                "V2: Structured instructions, grounding constraints, and few-shot examples."}
              {version === "V3" &&
                "V3: 5-stage workflow executed stage-by-stage with blind independent verification & disagreement adjudication."}
              {version === "ALL" &&
                "Runs V1, V2, and staged V3 sequentially on the same input, preserving each completed version."}
            </p>
          </div>

          <button
            type="button"
            disabled={loading}
            onClick={handleVerify}
            className="w-full rounded-md bg-teal-600 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading
              ? progressLabel || "Running Verification..."
              : "Verify Against Sources"}
          </button>
        </div>

        {/* Right: Reference Sources */}
        <div className="space-y-4 rounded-lg border border-[#243049] bg-[#111827] p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Trusted Reference Sources ({sources.length})
            </label>
            <div className="flex items-center gap-2">
              <label className="cursor-pointer rounded border border-[#243049] bg-[#131b2e] px-2.5 py-1.5 text-xs text-teal-300 hover:border-teal-500/40">
                {uploading ? "Parsing..." : "Upload PDF / TXT"}
                <input
                  type="file"
                  accept=".pdf,.txt,application/pdf,text/plain"
                  onChange={handleFileUpload}
                  disabled={uploading}
                  className="hidden"
                />
              </label>
              <button
                type="button"
                onClick={addTextSource}
                className="rounded border border-[#243049] bg-[#131b2e] px-2.5 py-1.5 text-xs text-slate-300 hover:border-teal-500/40"
              >
                + Add Text Source
              </button>
            </div>
          </div>

          <div className="max-h-[340px] space-y-3 overflow-y-auto pr-1">
            {sources.map((src, idx) => (
              <div
                key={src.id}
                className="rounded-md border border-[#243049] bg-[#090e1a] p-3"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-[#1e293b] px-1.5 py-0.5 font-mono text-[11px] text-teal-300">
                      {src.id}
                    </span>
                    <input
                      type="text"
                      value={src.title}
                      onChange={(e) =>
                        updateSource(idx, { title: e.target.value })
                      }
                      className="bg-transparent text-xs font-medium text-slate-200 focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-slate-500">
                    <span>{src.type.toUpperCase()}</span>
                    <span>{src.charCount} chars</span>
                    {sources.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeSource(idx)}
                        className="text-rose-400 hover:text-rose-300"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
                <textarea
                  value={src.content}
                  onChange={(e) =>
                    updateSource(idx, { content: e.target.value })
                  }
                  rows={4}
                  placeholder="Paste reference text or upload a PDF/TXT file..."
                  className="w-full rounded border border-[#1e293b] bg-[#111827] p-2 text-xs text-slate-200 placeholder-slate-500 focus:border-teal-500 focus:outline-none"
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">
          {error}
        </div>
      )}

      {/* Side-by-Side Comparison Matrix when Compare All Versions is run */}
      {results.length > 1 && (
        <div className="rounded-lg border border-teal-500/30 bg-[#111827] p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#243049] pb-3">
            <div>
              <h3 className="text-sm font-semibold text-teal-200">
                Side-by-Side Version Comparison (Live Session)
              </h3>
              <p className="mt-0.5 text-xs text-slate-400">
                Direct comparison of completed versions: verdicts, confidence,
                citation validity, latency, and token cost.
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                downloadJson(
                  `truthlens_comparison_${new Date().toISOString().slice(0, 10)}.json`,
                  results
                )
              }
              className="rounded border border-[#243049] bg-[#131b2e] px-3 py-1.5 text-xs text-teal-300 hover:border-teal-500/40"
            >
              Download Comparison Trace (JSON)
            </button>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            {results.map((run) => (
              <div
                key={`cmp-${run.runId}`}
                className="flex flex-col justify-between rounded-md border border-[#243049] bg-[#090e1a] p-4"
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between border-b border-[#1e293b] pb-2">
                    <span className="rounded bg-teal-500/15 px-2 py-0.5 font-mono text-xs font-semibold text-teal-300">
                      {run.version}
                    </span>
                    <span className="font-mono text-[11px] text-slate-400">
                      {run.metrics.totalLatencyMs}ms ·{" "}
                      {run.metrics.totalInputTokens +
                        run.metrics.totalOutputTokens}{" "}
                      tok
                    </span>
                  </div>
                  <div className="space-y-2">
                    {run.claims.map((c) => (
                      <div
                        key={c.claimId}
                        className="rounded border border-[#1e293b] bg-[#111827] p-2.5 text-xs"
                      >
                        <div className="font-medium text-slate-200">
                          {c.claimId}: {c.claimText}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <VerdictBadge verdict={c.verdict} />
                          <ConfidenceBadge
                            confidence={c.confidence}
                            reason={c.confidenceReason}
                          />
                        </div>
                        <div className="mt-1 text-[10px] text-slate-400">
                          Truth Conf: {c.factualTruthConfidence} · Citations:{" "}
                          {c.citations.filter((x) => x.verified).length}/
                          {c.citations.length}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-[#1e293b] pt-2 text-[11px]">
                  <span className="text-slate-400">
                    Stages: {run.stages.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => onInspectRunInWorkflow(run.runId)}
                    className="text-teal-400 hover:text-teal-300"
                  >
                    Inspect Trace →
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Detailed Results */}
      {results.map((run) => (
        <div
          key={run.runId}
          className="space-y-4 rounded-lg border border-[#243049] bg-[#111827] p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#243049] pb-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="rounded bg-teal-500/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-teal-300">
                LIVE SESSION
              </span>
              <span className="rounded bg-teal-500/15 px-2 py-0.5 font-mono text-xs font-semibold text-teal-300">
                {run.version}
              </span>
              <span className="text-sm font-semibold text-slate-100">
                Verification Report
              </span>
              <span className="text-xs text-slate-500">
                Model: {run.modelConfig.model} · {run.metrics.totalLatencyMs}ms ·{" "}
                {run.metrics.totalInputTokens + run.metrics.totalOutputTokens}{" "}
                tokens
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-400">
                Verbatim Citations:{" "}
                <strong className="text-teal-300">
                  {run.metrics.verifiedCitations}/{run.metrics.totalCitations}
                </strong>
              </span>
              <button
                type="button"
                onClick={() =>
                  downloadJson(
                    `truthlens_${run.version}_${run.runId.slice(0, 8)}.json`,
                    run
                  )
                }
                className="rounded border border-[#243049] bg-[#131b2e] px-2.5 py-1 text-xs text-slate-300 hover:border-teal-500/40"
              >
                Download JSON
              </button>
              <button
                type="button"
                onClick={() =>
                  downloadText(
                    `truthlens_${run.version}_${run.runId.slice(0, 8)}.md`,
                    formatVerificationRunMarkdown(run)
                  )
                }
                className="rounded border border-[#243049] bg-[#131b2e] px-2.5 py-1 text-xs text-slate-300 hover:border-teal-500/40"
              >
                Download MD
              </button>
              <button
                type="button"
                onClick={() => onInspectRunInWorkflow(run.runId)}
                className="rounded border border-[#243049] bg-[#131b2e] px-2.5 py-1 text-xs text-teal-300 hover:border-teal-500/40"
              >
                Inspect Stages
              </button>
            </div>
          </div>

          {run.injectionScan.flagged && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
              <strong>Prompt Injection Warning:</strong>{" "}
              {run.injectionScan.warnings.join("; ")}. Input was isolated inside
              untrusted data boundaries.
            </div>
          )}

          <div className="rounded-md border border-[#1e293b] bg-[#090e1a] p-3.5 text-sm text-slate-200">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Executive Summary
            </div>
            <p className="mt-1">{run.summary}</p>
            {run.methodologyNote && (
              <p className="mt-2 text-xs text-slate-400">
                <strong>Methodology Note:</strong> {run.methodologyNote}
              </p>
            )}
          </div>

          <div className="space-y-3">
            {run.claims.map((claim) => (
              <div
                key={claim.claimId}
                className="rounded-md border border-[#243049] bg-[#0d1424] p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 font-mono text-xs text-slate-500">
                      {claim.claimId}
                    </span>
                    <p className="text-sm font-medium text-slate-100">
                      {claim.claimText}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <VerdictBadge verdict={claim.verdict} />
                    <ConfidenceBadge
                      confidence={claim.confidence}
                      reason={claim.confidenceReason}
                    />
                  </div>
                </div>

                <p className="mt-2 text-xs leading-relaxed text-slate-300">
                  {claim.explanation}
                </p>

                {claim.missingInformation && (
                  <div className="mt-2 rounded border border-amber-500/25 bg-amber-500/5 p-2.5 text-[11px] text-amber-200">
                    <div>
                      <strong>Missing Information:</strong>{" "}
                      {claim.missingInformation}
                    </div>
                    {claim.requiredEvidence && (
                      <div className="mt-1">
                        <strong>Required Evidence:</strong>{" "}
                        {claim.requiredEvidence}
                      </div>
                    )}
                  </div>
                )}

                <div className="mt-2 space-y-1 text-[11px] text-slate-400">
                  <div>
                    <strong>Verdict Confidence:</strong> {claim.confidenceReason}
                  </div>
                  <div>
                    <strong>Factual Truth Confidence:</strong>{" "}
                    {claim.factualTruthNote}
                  </div>
                  <div>
                    <strong>Source Credibility:</strong>{" "}
                    {claim.sourceCredibilityStatus}
                  </div>
                </div>

                {claim.verificationAgreement &&
                  claim.verificationAgreement !== "single_pass" && (
                    <div className="mt-1.5 text-[11px] text-slate-400">
                      <strong>Independent Verification:</strong>{" "}
                      {claim.verificationAgreement === "agreed"
                        ? `Stage 3 and blind Stage 4 agreed (${claim.stage3Verdict}).`
                        : `Stage 3 (${claim.stage3Verdict}) and blind Stage 4 (${claim.stage4Verdict}) disagreed → adjudicated by Stage 4b reviewer.`}
                    </div>
                  )}

                {claim.evidenceAlignment?.assessed && (
                  <div className="mt-1.5 text-[11px] text-slate-400">
                    <strong>Evidence-Verdict Alignment:</strong>{" "}
                    <span
                      className={
                        claim.evidenceAlignment.supportsVerdict
                          ? "text-emerald-300"
                          : "text-rose-300"
                      }
                    >
                      {claim.evidenceAlignment.supportsVerdict
                        ? "Genuinely Supported"
                        : "Weak / Misaligned"}
                    </span>{" "}
                    — {claim.evidenceAlignment.note}
                  </div>
                )}

                {claim.citations.length > 0 && (
                  <div className="mt-3 space-y-1.5 border-t border-[#1e293b] pt-2.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      Citations
                    </div>
                    {claim.citations.map((cit, idx) => (
                      <div
                        key={idx}
                        className="rounded border border-[#1e293b] bg-[#090e1a] p-2 text-xs"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-mono text-[11px] text-teal-300">
                            [{cit.sourceId}] {cit.sourceTitle}
                          </span>
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                              cit.verified
                                ? "bg-emerald-500/15 text-emerald-300"
                                : "bg-rose-500/15 text-rose-300"
                            }`}
                          >
                            {cit.verified
                              ? "Verbatim Verified"
                              : "Unverified Quote"}
                          </span>
                        </div>
                        <blockquote className="mt-1 border-l-2 border-teal-500/40 pl-2 italic text-slate-300">
                          &ldquo;{cit.quote}&rdquo;
                        </blockquote>
                        {!cit.verified && (
                          <div className="mt-1 text-[11px] text-rose-300">
                            {cit.validationNote}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
