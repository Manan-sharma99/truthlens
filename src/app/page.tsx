"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EvaluationSection } from "@/components/EvaluationSection";
import { OverviewSection } from "@/components/OverviewSection";
import { PromptWorkflowSection } from "@/components/PromptWorkflowSection";
import { VerifyClaimsSection } from "@/components/VerifyClaimsSection";
import type {
  AppValidationResult,
  EvalCase,
  EvalRunResult,
  PromptIterationEntry,
  PromptTemplate,
  PromptVersion,
  ReferenceSource,
  VerificationRun,
} from "@/lib/types";

type NavTab = "overview" | "verify" | "workflow" | "evaluation";

const NAV_ITEMS: Array<{ id: NavTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "verify", label: "Verify Claims" },
  { id: "workflow", label: "Prompt Workflow" },
  { id: "evaluation", label: "Evaluation" },
];

const SESSION_RUNS_KEY = "truthlens_session_runs_v1";
const SESSION_RESULTS_KEY = "truthlens_session_latest_results_v1";
const MAX_STORED_SESSION_RUNS = 15;

export interface VerifyDraftState {
  claimInput: string;
  sources: ReferenceSource[];
  version: PromptVersion | "ALL";
}

function safeReadSessionJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export default function TruthLensApp() {
  const [activeTab, setActiveTab] = useState<NavTab>("overview");
  const [apiConfigured, setApiConfigured] = useState<boolean | null>(null);
  const [modelName, setModelName] = useState<string>("");
  const [readOnlyProduction, setReadOnlyProduction] = useState<boolean>(false);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);

  // Historical persisted runs from server (read-only JSON in production, data/runs.json in local dev)
  const [historicalRuns, setHistoricalRuns] = useState<VerificationRun[]>([]);
  // Live current-session runs kept in React state + sessionStorage across tab switches
  const [sessionRuns, setSessionRuns] = useState<VerificationRun[]>([]);
  const [latestVerifyResults, setLatestVerifyResults] = useState<
    VerificationRun[]
  >([]);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);

  const [verifyDraft, setVerifyDraft] = useState<VerifyDraftState>({
    claimInput: "",
    sources: [
      {
        id: "S1",
        title: "Reference Source 1",
        type: "text",
        content: "",
        charCount: 0,
      },
    ],
    version: "V3",
  });

  const [evalRuns, setEvalRuns] = useState<EvalRunResult[]>([]);
  const [appValidationResults, setAppValidationResults] = useState<
    AppValidationResult[]
  >([]);
  const [benchmarkCases, setBenchmarkCases] = useState<EvalCase[]>([]);
  const [promptIterations, setPromptIterations] = useState<
    PromptIterationEntry[]
  >([]);
  const [temperatureExperiment, setTemperatureExperiment] = useState<unknown[]>(
    []
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const persistSessionRuns = useCallback((runs: VerificationRun[], latest: VerificationRun[]) => {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(
        SESSION_RUNS_KEY,
        JSON.stringify(runs.slice(0, MAX_STORED_SESSION_RUNS))
      );
      window.sessionStorage.setItem(
        SESSION_RESULTS_KEY,
        JSON.stringify(latest)
      );
      setStorageWarning(null);
    } catch {
      // Handle browser QuotaExceededError gracefully: trim stored history while keeping React state intact
      try {
        window.sessionStorage.setItem(
          SESSION_RUNS_KEY,
          JSON.stringify(runs.slice(0, 3))
        );
        window.sessionStorage.setItem(
          SESSION_RESULTS_KEY,
          JSON.stringify(latest.slice(0, 3))
        );
        setStorageWarning(
          "Browser session storage reached capacity; older session traces were trimmed from browser storage (download JSON reports to keep full logs)."
        );
      } catch {
        setStorageWarning(
          "Browser session storage is unavailable or full; current-session runs remain in page memory until reload. Download JSON reports to save them."
        );
      }
    }
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [healthRes, promptsRes, runsRes] = await Promise.all([
        fetch("/api/health"),
        fetch("/api/prompts"),
        fetch("/api/runs"),
      ]);
      if (healthRes.ok) {
        const h = await healthRes.json();
        setApiConfigured(Boolean(h.configured));
        setModelName(h.model || "");
        setReadOnlyProduction(Boolean(h.readOnlyProduction));
      }
      if (promptsRes.ok) {
        const p = await promptsRes.json();
        setTemplates(p.prompts ?? []);
      }
      if (runsRes.ok) {
        const r = await runsRes.json();
        setHistoricalRuns(r.verificationRuns ?? []);
        setEvalRuns(r.evalRuns ?? []);
        setAppValidationResults(r.appValidationResults ?? []);
        setBenchmarkCases(r.benchmarkCases ?? []);
        setPromptIterations(r.promptIterations ?? []);
        setTemperatureExperiment(r.temperatureExperiment ?? []);
        if (typeof r.readOnlyProduction === "boolean") {
          setReadOnlyProduction(r.readOnlyProduction);
        }
      }
    } catch {
      // Handled gracefully in UI
    }
  }, []);

  useEffect(() => {
    const savedSession = safeReadSessionJson<VerificationRun[]>(
      SESSION_RUNS_KEY,
      []
    );
    const savedLatest = safeReadSessionJson<VerificationRun[]>(
      SESSION_RESULTS_KEY,
      []
    );
    if (savedSession.length > 0) setSessionRuns(savedSession);
    if (savedLatest.length > 0) setLatestVerifyResults(savedLatest);
    loadData();
  }, [loadData]);

  // Merge live session runs ahead of historical runs without duplicating runIds
  const sessionRunIds = useMemo(
    () => new Set(sessionRuns.map((r) => r.runId)),
    [sessionRuns]
  );

  const combinedRuns = useMemo(() => {
    const dedupedHistorical = historicalRuns.filter(
      (r) => !sessionRunIds.has(r.runId)
    );
    return [...sessionRuns, ...dedupedHistorical];
  }, [sessionRuns, historicalRuns, sessionRunIds]);

  function handleRunCompleted(newRuns: VerificationRun[]) {
    if (newRuns.length === 0) return;
    setLatestVerifyResults(newRuns);
    const updatedSession = [
      ...newRuns,
      ...sessionRuns.filter(
        (existing) => !newRuns.some((nr) => nr.runId === existing.runId)
      ),
    ];
    setSessionRuns(updatedSession);
    persistSessionRuns(updatedSession, newRuns);
    if (!readOnlyProduction) {
      loadData();
    }
  }

  function handleClearSession() {
    setSessionRuns([]);
    setLatestVerifyResults([]);
    setStorageWarning(null);
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.removeItem(SESSION_RUNS_KEY);
        window.sessionStorage.removeItem(SESSION_RESULTS_KEY);
      } catch {
        // Ignore storage errors
      }
    }
  }

  function handleInspectRunInWorkflow(runId: string) {
    setSelectedRunId(runId);
    setActiveTab("workflow");
  }

  return (
    <div className="min-h-screen bg-[#090e1a] text-slate-200">
      {/* Top Bar */}
      <header className="sticky top-0 z-20 border-b border-[#243049] bg-[#0b1120]/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md border border-teal-500/40 bg-teal-500/15 font-mono text-sm font-bold text-teal-300">
              TL
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight text-slate-100">
                TruthLens
              </h1>
              <p className="text-[11px] text-slate-400">
                Evidence-Grounded Fact-Checking &amp; Prompt Engineering
                Workbench
              </p>
            </div>
          </div>

          <nav className="flex items-center gap-1 rounded-md border border-[#243049] bg-[#111827] p-1">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`rounded px-3 py-1.5 text-xs font-medium transition ${
                  activeTab === item.id
                    ? "bg-teal-500/20 text-teal-200"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {item.label}
                {item.id === "verify" && sessionRuns.length > 0 && (
                  <span className="ml-1.5 rounded bg-teal-500/20 px-1 py-0.5 text-[10px] text-teal-300">
                    {sessionRuns.length}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            {readOnlyProduction && (
              <span className="rounded border border-[#243049] bg-[#131b2e] px-2 py-0.5 text-[10px] font-medium text-teal-300">
                Stateless Production · Session Storage
              </span>
            )}
            <div className="flex items-center gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  apiConfigured
                    ? "bg-emerald-400"
                    : apiConfigured === false
                      ? "bg-amber-400"
                      : "bg-slate-500"
                }`}
              />
              <span className="text-slate-400">
                {apiConfigured
                  ? `Connected (${modelName})`
                  : apiConfigured === false
                    ? "API Key Missing"
                    : "Checking..."}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {storageWarning && (
          <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
            {storageWarning}
          </div>
        )}

        {activeTab === "overview" && (
          <OverviewSection
            verificationRuns={combinedRuns}
            sessionRunIds={sessionRunIds}
            evalRuns={evalRuns}
            apiConfigured={apiConfigured}
            modelName={modelName}
            readOnlyProduction={readOnlyProduction}
            onClearSession={handleClearSession}
            onNavigate={setActiveTab}
          />
        )}

        {activeTab === "verify" && (
          <VerifyClaimsSection
            draft={verifyDraft}
            onDraftChange={setVerifyDraft}
            results={latestVerifyResults}
            onRunCompleted={handleRunCompleted}
            onInspectRunInWorkflow={handleInspectRunInWorkflow}
          />
        )}

        {activeTab === "workflow" && (
          <PromptWorkflowSection
            templates={templates}
            runs={combinedRuns}
            sessionRunIds={sessionRunIds}
            selectedRunId={selectedRunId}
            onSelectRunId={setSelectedRunId}
          />
        )}

        {activeTab === "evaluation" && (
          <EvaluationSection
            evalRuns={evalRuns}
            benchmarkCases={benchmarkCases}
            appValidationResults={appValidationResults}
            promptIterations={promptIterations}
            temperatureExperiment={temperatureExperiment}
            readOnlyProduction={readOnlyProduction}
            onAppValidationCompleted={(results) =>
              setAppValidationResults(results)
            }
            onEvalCompleted={loadData}
            onInspectRunInWorkflow={handleInspectRunInWorkflow}
          />
        )}
      </main>
    </div>
  );
}
