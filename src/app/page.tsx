"use client";

import { useCallback, useEffect, useState } from "react";
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
  VerificationRun,
} from "@/lib/types";

type NavTab = "overview" | "verify" | "workflow" | "evaluation";

const NAV_ITEMS: Array<{ id: NavTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "verify", label: "Verify Claims" },
  { id: "workflow", label: "Prompt Workflow" },
  { id: "evaluation", label: "Evaluation" },
];

export default function TruthLensApp() {
  const [activeTab, setActiveTab] = useState<NavTab>("overview");
  const [apiConfigured, setApiConfigured] = useState<boolean | null>(null);
  const [modelName, setModelName] = useState<string>("");
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [verificationRuns, setVerificationRuns] = useState<VerificationRun[]>(
    []
  );
  const [evalRuns, setEvalRuns] = useState<EvalRunResult[]>([]);
  const [appValidationResults, setAppValidationResults] = useState<
    AppValidationResult[]
  >([]);
  const [benchmarkCases, setBenchmarkCases] = useState<EvalCase[]>([]);
  const [promptIterations, setPromptIterations] = useState<
    PromptIterationEntry[]
  >([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

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
      }
      if (promptsRes.ok) {
        const p = await promptsRes.json();
        setTemplates(p.prompts ?? []);
      }
      if (runsRes.ok) {
        const r = await runsRes.json();
        setVerificationRuns(r.verificationRuns ?? []);
        setEvalRuns(r.evalRuns ?? []);
        setAppValidationResults(r.appValidationResults ?? []);
        setBenchmarkCases(r.benchmarkCases ?? []);
        setPromptIterations(r.promptIterations ?? []);
      }
    } catch {
      // Handled gracefully in UI
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

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
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-2 text-xs">
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
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {activeTab === "overview" && (
          <OverviewSection
            verificationRuns={verificationRuns}
            evalRuns={evalRuns}
            apiConfigured={apiConfigured}
            modelName={modelName}
            onNavigate={setActiveTab}
          />
        )}

        {activeTab === "verify" && (
          <VerifyClaimsSection
            onRunCompleted={loadData}
            onInspectRunInWorkflow={handleInspectRunInWorkflow}
          />
        )}

        {activeTab === "workflow" && (
          <PromptWorkflowSection
            templates={templates}
            runs={verificationRuns}
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
            onEvalCompleted={loadData}
            onInspectRunInWorkflow={handleInspectRunInWorkflow}
          />
        )}
      </main>
    </div>
  );
}
