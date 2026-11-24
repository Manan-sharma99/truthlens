import fs from "node:fs";
import path from "node:path";
import type {
  AppValidationResult,
  EvalCase,
  EvalRunResult,
  PromptIterationEntry,
  VerificationRun,
} from "./types.ts";

const DATA_DIR = path.join(process.cwd(), "data");
const RUNS_FILE = path.join(DATA_DIR, "runs.json");
const EVAL_BENCHMARK_FILE = path.join(DATA_DIR, "eval_benchmark.json");
const ITERATIONS_FILE = path.join(DATA_DIR, "prompt_iterations.json");

interface PersistedStore {
  verificationRuns: VerificationRun[];
  evalRuns: EvalRunResult[];
  appValidationResults: AppValidationResult[];
}

function ensureStore(): PersistedStore {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(RUNS_FILE)) {
    const empty: PersistedStore = {
      verificationRuns: [],
      evalRuns: [],
      appValidationResults: [],
    };
    fs.writeFileSync(RUNS_FILE, JSON.stringify(empty, null, 2), "utf-8");
    return empty;
  }
  const raw = fs.readFileSync(RUNS_FILE, "utf-8");
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedStore>;
    return {
      verificationRuns: Array.isArray(parsed.verificationRuns)
        ? parsed.verificationRuns
        : [],
      evalRuns: Array.isArray(parsed.evalRuns) ? parsed.evalRuns : [],
      appValidationResults: Array.isArray(parsed.appValidationResults)
        ? parsed.appValidationResults
        : [],
    };
  } catch {
    return {
      verificationRuns: [],
      evalRuns: [],
      appValidationResults: [],
    };
  }
}

function writeStore(store: PersistedStore): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(RUNS_FILE, JSON.stringify(store, null, 2), "utf-8");
}

export function saveVerificationRun(run: VerificationRun): void {
  const store = ensureStore();
  store.verificationRuns.unshift(run);
  store.verificationRuns = store.verificationRuns.slice(0, 150);
  writeStore(store);
}

export function saveEvalRun(evalRun: EvalRunResult): void {
  const store = ensureStore();
  const idx = store.evalRuns.findIndex((e) => e.evalId === evalRun.evalId);
  if (idx >= 0) {
    store.evalRuns[idx] = evalRun;
  } else {
    store.evalRuns.unshift(evalRun);
  }
  store.evalRuns = store.evalRuns.slice(0, 50);
  writeStore(store);
}

export function saveAppValidationResults(
  results: AppValidationResult[]
): void {
  const store = ensureStore();
  store.appValidationResults = results;
  writeStore(store);
}

export function getPersistedData(): PersistedStore {
  return ensureStore();
}

export function clearPersistedData(): void {
  writeStore({
    verificationRuns: [],
    evalRuns: [],
    appValidationResults: [],
  });
}

export function loadEvalBenchmark(): EvalCase[] {
  if (!fs.existsSync(EVAL_BENCHMARK_FILE)) {
    return [];
  }
  const raw = fs.readFileSync(EVAL_BENCHMARK_FILE, "utf-8");
  return JSON.parse(raw) as EvalCase[];
}

export function loadPromptIterations(): PromptIterationEntry[] {
  if (!fs.existsSync(ITERATIONS_FILE)) {
    return [];
  }
  const raw = fs.readFileSync(ITERATIONS_FILE, "utf-8");
  return JSON.parse(raw) as PromptIterationEntry[];
}

export function savePromptIteration(entry: PromptIterationEntry): void {
  const list = loadPromptIterations();
  const idx = list.findIndex((i) => i.iterationId === entry.iterationId);
  if (idx >= 0) {
    list[idx] = entry;
  } else {
    list.push(entry);
  }
  fs.writeFileSync(ITERATIONS_FILE, JSON.stringify(list, null, 2), "utf-8");
}

/**
 * Finds the most recent partial eval run for the given version and splitFilter.
 * Used to support incremental resume: skip already-completed cases.
 */
export function loadLatestPartialEvalRun(
  version: string,
  splitFilter: string
): import("./types").EvalRunResult | undefined {
  const store = ensureStore();
  // Find the most recent partial run matching version + split
  const matching = store.evalRuns.filter(
    (e) =>
      e.version === version &&
      e.splitFilter === splitFilter &&
      (e as unknown as Record<string, unknown>).partial === true
  );
  if (matching.length === 0) return undefined;
  // Sort by createdAt descending, return the most recent
  matching.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return matching[0];
}
