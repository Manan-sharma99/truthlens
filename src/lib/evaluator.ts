import crypto from "node:crypto";
import { getModelName } from "./llm.ts";
import { runVerification, type StructuredLlmCaller } from "./pipeline.ts";
import {
  getPersistedData,
  loadEvalBenchmark,
  loadLatestPartialEvalRun,
  saveEvalRun,
  saveVerificationRun,
} from "./storage.ts";
import type {
  EvalCase,
  EvalCaseResult,
  EvalMode,
  EvalModeSummary,
  EvalRunResult,
  EvalSplit,
  FailureRecord,
  PromptVersion,
  VerificationRun,
  VerifiedClaim,
} from "./types.ts";

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9%$.\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function tokenOverlapRatio(a: string, b: string): number {
  const ta = Array.from(new Set(tokenize(a)));
  const tb = new Set(tokenize(b));
  if (ta.length === 0 || tb.size === 0) return 0;
  const intersection = ta.filter((w) => tb.has(w)).length;
  return intersection / Math.min(ta.length, tb.size);
}

function scoreClaimMatch(keyPhrase: string, claimText: string): number {
  const kp = keyPhrase.toLowerCase().trim();
  const ct = claimText.toLowerCase();
  if (!kp) return 0;
  if (ct.includes(kp)) {
    // Prefer exact substring matches, slightly favoring tighter/more specific claimText
    return 1 + Math.min(kp.length / Math.max(ct.length, 1), 0.5);
  }
  const words = kp.split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return 0;
  const matches = words.filter((w) => ct.includes(w)).length;
  const ratio = matches / words.length;
  return ratio >= 0.45 ? ratio : 0;
}

export interface ClaimMatchingResult {
  /** 1-to-1 matched claim for each expectedClaim index (undefined if missed) */
  matchedByExpectedIdx: Array<VerifiedClaim | undefined>;
  /** Extra extracted claims not paired to any expectedClaim */
  extraClaims: Array<{
    claim: VerifiedClaim;
    classification: "Duplicate Claim" | "Unexpected Claim";
    overlapDetails: string;
  }>;
}

/**
 * Performs 1-to-1 greedy best matching between expectedClaims and actual extracted claims,
 * and classifies any remaining unmatched extracted claims as Duplicate or Unexpected.
 */
export function matchClaimsOneToOne(
  expectedClaims: EvalCase["expectedClaims"],
  actualClaims: VerifiedClaim[]
): ClaimMatchingResult {
  const candidates: Array<{ expIdx: number; actIdx: number; score: number }> = [];
  for (let i = 0; i < expectedClaims.length; i++) {
    for (let j = 0; j < actualClaims.length; j++) {
      const score = scoreClaimMatch(
        expectedClaims[i].keyPhrase,
        actualClaims[j].claimText
      );
      if (score > 0) {
        candidates.push({ expIdx: i, actIdx: j, score });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const matchedExp = new Set<number>();
  const matchedAct = new Set<number>();
  const matchedByExpectedIdx: Array<VerifiedClaim | undefined> = new Array(
    expectedClaims.length
  ).fill(undefined);

  for (const cand of candidates) {
    if (matchedExp.has(cand.expIdx) || matchedAct.has(cand.actIdx)) continue;
    matchedExp.add(cand.expIdx);
    matchedAct.add(cand.actIdx);
    matchedByExpectedIdx[cand.expIdx] = actualClaims[cand.actIdx];
  }

  const extraClaims: ClaimMatchingResult["extraClaims"] = [];
  const seenTexts: VerifiedClaim[] = actualClaims.filter((_, idx) =>
    matchedAct.has(idx)
  );

  for (let j = 0; j < actualClaims.length; j++) {
    if (matchedAct.has(j)) continue;
    const extra = actualClaims[j];
    let bestOverlap = 0;
    let overlapTarget: VerifiedClaim | undefined;

    for (const prev of seenTexts) {
      const ov = tokenOverlapRatio(extra.claimText, prev.claimText);
      if (ov > bestOverlap) {
        bestOverlap = ov;
        overlapTarget = prev;
      }
    }

    const isDuplicate = bestOverlap >= 0.45 && overlapTarget !== undefined;
    extraClaims.push({
      claim: extra,
      classification: isDuplicate ? "Duplicate Claim" : "Unexpected Claim",
      overlapDetails: isDuplicate
        ? `Overlaps (${Math.round(bestOverlap * 100)}%) with ${overlapTarget!.claimId} ("${overlapTarget!.claimText}").`
        : "Does not correspond to any expected claim in this test case.",
    });
    seenTexts.push(extra);
  }

  return { matchedByExpectedIdx, extraClaims };
}

interface ModeAccumulator {
  totalCases: number;
  expectedClaims: number;
  matchedVerdicts: number;
  totalCitations: number;
  verifiedCitations: number;
  negativeExpected: number;
  overconfidentSupported: number;
}

function createAcc(): ModeAccumulator {
  return {
    totalCases: 0,
    expectedClaims: 0,
    matchedVerdicts: 0,
    totalCitations: 0,
    verifiedCitations: 0,
    negativeExpected: 0,
    overconfidentSupported: 0,
  };
}

function summarizeAcc(acc: ModeAccumulator): EvalModeSummary {
  return {
    totalCases: acc.totalCases,
    verdictAccuracy:
      acc.expectedClaims === 0 ? 0 : acc.matchedVerdicts / acc.expectedClaims,
    citationValidityRate:
      acc.totalCitations === 0
        ? 1
        : acc.verifiedCitations / acc.totalCitations,
    overconfidenceRate:
      acc.negativeExpected === 0
        ? 0
        : acc.overconfidentSupported / acc.negativeExpected,
  };
}

export interface RecomputedEvalMetrics {
  totalCases: number;
  verdictAccuracy: number;
  citationValidityRate: number;
  overconfidenceRate: number;
  avgLatencyMs: number;
  totalTokens: number;
  byMode: {
    atomic: EvalModeSummary;
    end_to_end: EvalModeSummary;
  };
}

/**
 * Recomputes all aggregate and by-mode metrics deterministically across EVERY caseResult
 * (both previously saved partial cases and newly executed cases) so resumed evaluations
 * never drop byMode accuracy, citation counts, or overconfidence rates.
 */
export function recomputeEvalMetrics(
  caseResults: EvalCaseResult[],
  failures: FailureRecord[],
  allCases: EvalCase[],
  verificationRuns: VerificationRun[]
): RecomputedEvalMetrics {
  const caseById = new Map(allCases.map((c) => [c.id, c]));
  const runById = new Map(verificationRuns.map((r) => [r.runId, r]));

  const overall = createAcc();
  const byModeAcc: Record<EvalMode, ModeAccumulator> = {
    atomic: createAcc(),
    end_to_end: createAcc(),
  };

  let totalLatencyMs = 0;
  let totalTokens = 0;

  for (const cr of caseResults) {
    const modeKey: EvalMode =
      cr.evalMode === "end_to_end" ? "end_to_end" : "atomic";
    const modeAcc = byModeAcc[modeKey];

    overall.totalCases += 1;
    modeAcc.totalCases += 1;

    overall.matchedVerdicts += cr.matchedClaims;
    overall.expectedClaims += cr.expectedClaimsCount;
    modeAcc.matchedVerdicts += cr.matchedClaims;
    modeAcc.expectedClaims += cr.expectedClaimsCount;

    totalLatencyMs += cr.latencyMs;
    totalTokens += cr.tokens;

    const vr = runById.get(cr.runId);
    if (vr) {
      overall.totalCitations += vr.metrics.totalCitations;
      overall.verifiedCitations += vr.metrics.verifiedCitations;
      modeAcc.totalCitations += vr.metrics.totalCitations;
      modeAcc.verifiedCitations += vr.metrics.verifiedCitations;
    } else if (cr.citationValidityRate < 1) {
      overall.totalCitations += 1;
      overall.verifiedCitations += cr.citationValidityRate;
      modeAcc.totalCitations += 1;
      modeAcc.verifiedCitations += cr.citationValidityRate;
    }

    const evalCase = caseById.get(cr.caseId);
    if (evalCase) {
      const negCount = evalCase.expectedClaims.filter(
        (e) =>
          e.expectedVerdict === "Insufficient Evidence" ||
          e.expectedVerdict === "Contradicted"
      ).length;
      overall.negativeExpected += negCount;
      modeAcc.negativeExpected += negCount;
    }

    const overconfCount = failures.filter(
      (f) =>
        f.caseId === cr.caseId &&
        f.failureType === "Overconfident Unsupported"
    ).length;
    overall.overconfidentSupported += overconfCount;
    modeAcc.overconfidentSupported += overconfCount;
  }

  const overallSummary = summarizeAcc(overall);
  return {
    totalCases: caseResults.length,
    verdictAccuracy: overallSummary.verdictAccuracy,
    citationValidityRate: overallSummary.citationValidityRate,
    overconfidenceRate: overallSummary.overconfidenceRate,
    avgLatencyMs:
      caseResults.length === 0
        ? 0
        : Math.round(totalLatencyMs / caseResults.length),
    totalTokens,
    byMode: {
      atomic: summarizeAcc(byModeAcc.atomic),
      end_to_end: summarizeAcc(byModeAcc.end_to_end),
    },
  };
}

export async function runBenchmarkEvaluation(
  version: PromptVersion,
  options?: {
    caseIds?: string[];
    splitFilter?: EvalSplit | "all";
    evalMode?: EvalMode | "all";
    stage4Temperature?: number;
    resume?: boolean;
    llmCaller?: StructuredLlmCaller;
    persist?: boolean;
  }
): Promise<EvalRunResult> {
  const allCases = loadEvalBenchmark();
  const splitFilter = options?.splitFilter ?? "all";
  const evalModeFilter = options?.evalMode ?? "all";
  const stage4Temperature = options?.stage4Temperature;
  const shouldResume = options?.resume ?? false;
  const persist = options?.persist ?? true;

  let cases: EvalCase[] = allCases;
  if (options?.caseIds && options.caseIds.length > 0) {
    cases = cases.filter((c) => options.caseIds!.includes(c.id));
  } else {
    if (splitFilter !== "all") {
      cases = cases.filter((c) => c.split === splitFilter);
    }
    if (evalModeFilter !== "all") {
      cases = cases.filter((c) => c.evalMode === evalModeFilter);
    }
  }

  const totalTargetCount = cases.length;

  // Incremental resume: load existing partial run and skip already-completed cases
  let existingPartial: EvalRunResult | undefined;
  let existingCaseResults: EvalCaseResult[] = [];
  let existingFailures: FailureRecord[] = [];
  if (shouldResume && !options?.caseIds) {
    existingPartial = loadLatestPartialEvalRun(version, splitFilter);
    if (existingPartial) {
      existingCaseResults = existingPartial.caseResults ?? [];
      existingFailures = existingPartial.failures ?? [];
      const completedIds = new Set(existingCaseResults.map((r) => r.caseId));
      cases = cases.filter((c) => !completedIds.has(c.id));
    }
  }

  const evalId = existingPartial?.evalId ?? crypto.randomUUID();
  const createdAt = existingPartial?.createdAt ?? new Date().toISOString();
  const model = getModelName();

  const failures: FailureRecord[] = [...existingFailures];
  const caseResults: EvalCaseResult[] = [...existingCaseResults];

  // Track persisted + newly executed verification runs so recomputeEvalMetrics has full citation metrics
  const verificationRunCache: VerificationRun[] = persist
    ? [...getPersistedData().verificationRuns]
    : [];

  const buildSnapshot = (partial: boolean): EvalRunResult => {
    const metrics = recomputeEvalMetrics(
      caseResults,
      failures,
      allCases,
      verificationRunCache
    );
    return {
      evalId,
      createdAt,
      version,
      model,
      splitFilter,
      partial,
      totalCases: metrics.totalCases,
      verdictAccuracy: metrics.verdictAccuracy,
      citationValidityRate: metrics.citationValidityRate,
      overconfidenceRate: metrics.overconfidenceRate,
      avgLatencyMs: metrics.avgLatencyMs,
      totalTokens: metrics.totalTokens,
      byMode: metrics.byMode,
      caseResults,
      failures,
    };
  };

  for (const evalCase of cases) {
    try {
      const run = await runVerification(
        version,
        evalCase.claimInput,
        evalCase.sources,
        options?.llmCaller,
        stage4Temperature !== undefined ? { stage4Temperature } : undefined
      );
      verificationRunCache.unshift(run);
      if (persist) {
        saveVerificationRun(run);
      }

      const caseIssues: string[] = [];

      for (const claim of run.claims) {
        for (const cit of claim.citations) {
          if (!cit.verified) {
            caseIssues.push(`Unverified citation [${cit.sourceId}]`);
            failures.push({
              caseId: evalCase.id,
              caseTitle: evalCase.title,
              evalMode: evalCase.evalMode,
              split: evalCase.split,
              version,
              failureType: "Unverified Citation",
              expected: "Exact verbatim quote in supplied source",
              actual: `[${cit.sourceId}] "${cit.quote}"`,
              details: cit.validationNote,
            });
          }
        }
        if (
          claim.evidenceAlignment?.assessed &&
          !claim.evidenceAlignment.supportsVerdict
        ) {
          caseIssues.push(`Evidence-verdict misalignment on ${claim.claimId}`);
          failures.push({
            caseId: evalCase.id,
            caseTitle: evalCase.title,
            evalMode: evalCase.evalMode,
            split: evalCase.split,
            version,
            failureType: "Evidence-Verdict Misalignment",
            expected: "Cited evidence genuinely supports assigned verdict",
            actual: `${claim.verdict}`,
            details: claim.evidenceAlignment.note,
          });
        }
      }

      const matching = matchClaimsOneToOne(evalCase.expectedClaims, run.claims);
      let caseMatched = 0;

      for (let idx = 0; idx < evalCase.expectedClaims.length; idx++) {
        const expected = evalCase.expectedClaims[idx];
        const matched = matching.matchedByExpectedIdx[idx];

        const isNegativeGroundTruth =
          expected.expectedVerdict === "Insufficient Evidence" ||
          expected.expectedVerdict === "Contradicted";

        if (!matched) {
          caseIssues.push(`Missed claim: ${expected.keyPhrase}`);
          failures.push({
            caseId: evalCase.id,
            caseTitle: evalCase.title,
            evalMode: evalCase.evalMode,
            split: evalCase.split,
            version,
            failureType: "Missed Claim",
            expected: `${expected.keyPhrase} (${expected.expectedVerdict})`,
            actual: "Not extracted or matched",
            details:
              "The prompt failed to isolate or address this factual claim.",
          });
          continue;
        }

        if (matched.verdict === expected.expectedVerdict) {
          caseMatched += 1;
        } else {
          const isOverconfident =
            isNegativeGroundTruth &&
            matched.verdict === "Supported" &&
            (matched.confidence === "High" || matched.confidence === "Medium");

          caseIssues.push(
            `Expected ${expected.expectedVerdict}, got ${matched.verdict}`
          );
          failures.push({
            caseId: evalCase.id,
            caseTitle: evalCase.title,
            evalMode: evalCase.evalMode,
            split: evalCase.split,
            version,
            failureType: isOverconfident
              ? "Overconfident Unsupported"
              : "Verdict Mismatch",
            expected: expected.expectedVerdict,
            actual: `${matched.verdict} (Verdict Conf: ${matched.confidence})`,
            details: `Claim: "${matched.claimText}" — ${matched.explanation}`,
          });
        }
      }

      // Account for duplicate or unexpected extracted claims instead of silently ignoring them
      for (const extra of matching.extraClaims) {
        caseIssues.push(
          `${extra.classification} (${extra.claim.claimId}): "${extra.claim.claimText}"`
        );
        failures.push({
          caseId: evalCase.id,
          caseTitle: evalCase.title,
          evalMode: evalCase.evalMode,
          split: evalCase.split,
          version,
          failureType: extra.classification,
          expected: `${evalCase.expectedClaims.length} distinct expected claim(s)`,
          actual: `${extra.claim.claimId}: "${extra.claim.claimText}" (${extra.claim.verdict})`,
          details: extra.overlapDetails,
        });
      }

      const expectedOutput = evalCase.expectedClaims
        .map((e) => `${e.keyPhrase}: ${e.expectedVerdict}`)
        .join(" | ");
      const actualOutput =
        run.claims.length > 0
          ? run.claims
              .map((c) => `${c.claimId}: ${c.verdict} (${c.confidence})`)
              .join(" | ")
          : "No claims extracted";
      const confidenceSummary =
        run.claims.length > 0
          ? run.claims
              .map(
                (c) =>
                  `${c.claimId}: Verdict=${c.confidence}, Truth=${c.factualTruthConfidence}`
              )
              .join("; ")
          : "—";

      caseResults.push({
        caseId: evalCase.id,
        caseTitle: evalCase.title,
        category: evalCase.category,
        evalMode: evalCase.evalMode,
        split: evalCase.split,
        labelStatus: evalCase.labelStatus,
        claimInput: evalCase.claimInput,
        referenceSummary: evalCase.sources
          .map((s) => `[${s.id}] ${s.content}`)
          .join(" "),
        expectedOutput,
        actualOutput,
        passed:
          caseMatched === evalCase.expectedClaims.length &&
          run.metrics.citationValidityRate === 1 &&
          matching.extraClaims.length === 0,
        matchedClaims: caseMatched,
        expectedClaimsCount: evalCase.expectedClaims.length,
        extractedClaimsCount: run.claims.length,
        duplicateOrUnexpectedClaims: matching.extraClaims.length,
        citationValidityRate: run.metrics.citationValidityRate,
        confidenceSummary,
        observedIssue: caseIssues.length > 0 ? caseIssues.join("; ") : "None",
        latencyMs: run.metrics.totalLatencyMs,
        tokens:
          run.metrics.totalInputTokens + run.metrics.totalOutputTokens,
        runId: run.runId,
        summary: run.summary,
      });

      // Preserve completed results incrementally after every case
      if (persist) {
        saveEvalRun(buildSnapshot(caseResults.length < totalTargetCount));
      }
    } catch (err) {
      if (persist && caseResults.length > 0) {
        saveEvalRun(buildSnapshot(true));
      }
      throw err;
    }
  }

  const finalResult = buildSnapshot(false);
  if (persist) {
    saveEvalRun(finalResult);
  }
  return finalResult;
}
