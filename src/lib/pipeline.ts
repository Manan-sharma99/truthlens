import crypto from "node:crypto";
import { validateCitations, type RawCitation } from "./citation-validator.ts";
import { computeQualitativeConfidence } from "./confidence.ts";
import {
  formatSourcesBlock,
  sanitizeDelimiterTags,
  scanForPromptInjection,
} from "./injection-guard.ts";
import {
  callStructuredJson,
  getModelName,
  type LlmJsonResponse,
} from "./llm.ts";
import { loadPromptTemplate, renderPromptTemplate } from "./prompt-loader.ts";
import type {
  PromptVersion,
  ReferenceSource,
  StageTrace,
  Verdict,
  VerificationRun,
  VerifiedClaim,
} from "./types.ts";

const VALID_VERDICTS: Verdict[] = [
  "Supported",
  "Contradicted",
  "Insufficient Evidence",
  "Conflicting Evidence",
];

function normalizeVerdict(val: string | undefined): Verdict {
  if (!val) return "Insufficient Evidence";
  const match = VALID_VERDICTS.find(
    (v) => v.toLowerCase() === val.trim().toLowerCase()
  );
  return match ?? "Insufficient Evidence";
}

interface SinglePassResponse {
  summary?: string;
  claims?: Array<{
    claimId?: string;
    claimText?: string;
    verdict?: string;
    explanation?: string;
    citations?: RawCitation[];
    missingInformation?: string;
    requiredEvidence?: string;
  }>;
}

interface UnresolvedClaimEntity {
  entityRef?: string;
  reason?: string;
}

interface IdentityResolution {
  entityRef?: string;
  resolution?: string;
  detail?: string;
}

interface Stage1Response {
  claims?: Array<{
    claimId?: string;
    claimText?: string;
    originalSpan?: string;
    claimType?: string;
    inputForm?: string;
  }>;
  unresolvedClaimEntities?: UnresolvedClaimEntity[];
  nonFactualNotes?: string;
}

interface Stage2Response {
  evidenceMap?: Array<{
    claimId?: string;
    evidence?: Array<{
      sourceId?: string;
      quote?: string;
      stance?: string;
      relevanceNote?: string;
    }>;
    disconfirmingEvidence?: Array<{
      sourceId?: string;
      quote?: string;
      note?: string;
    }>;
    contextualLimitations?: string;
  }>;
  identityResolution?: IdentityResolution[];
}

interface Stage3Response {
  verifications?: Array<{
    claimId?: string;
    claimText?: string;
    verdict?: string;
    explanation?: string;
    citations?: RawCitation[];
    missingInformation?: string;
    requiredEvidence?: string;
  }>;
}

interface Stage4BlindResponse {
  independentVerifications?: Array<{
    claimId?: string;
    verdict?: string;
    explanation?: string;
    citations?: RawCitation[];
    unresolvedIdentities?: string;
    missingInformation?: string;
    requiredEvidence?: string;
  }>;
}

interface Stage4bAdjudicationResponse {
  adjudications?: Array<{
    claimId?: string;
    finalVerdict?: string;
    finalExplanation?: string;
    evidenceSupportsVerdict?: boolean;
    alignmentNote?: string;
    finalCitations?: RawCitation[];
  }>;
}

interface Stage5Response {
  summary?: string;
  methodologyNote?: string;
}

function computeRunMetrics(
  claims: VerifiedClaim[],
  stages: StageTrace[]
): VerificationRun["metrics"] {
  let totalCitations = 0;
  let verifiedCitations = 0;
  let disagreementCount = 0;

  for (const c of claims) {
    totalCitations += c.citations.length;
    verifiedCitations += c.citations.filter((cit) => cit.verified).length;
    if (c.verificationAgreement === "disagreed_reconciled") {
      disagreementCount += 1;
    }
  }
  const totalLatencyMs = stages.reduce((sum, s) => sum + s.latencyMs, 0);
  const totalInputTokens = stages.reduce((sum, s) => sum + s.inputTokens, 0);
  const totalOutputTokens = stages.reduce((sum, s) => sum + s.outputTokens, 0);

  return {
    totalLatencyMs,
    totalInputTokens,
    totalOutputTokens,
    totalCitations,
    verifiedCitations,
    citationValidityRate:
      totalCitations === 0 ? 1 : verifiedCitations / totalCitations,
    disagreementCount,
  };
}

export type StructuredLlmCaller = <T>(
  systemPrompt: string,
  userPrompt: string,
  temperature: number
) => Promise<LlmJsonResponse<T>>;

async function runSinglePass(
  version: "V1" | "V2",
  claimInput: string,
  sources: ReferenceSource[],
  llmCaller: StructuredLlmCaller
): Promise<{
  summary: string;
  methodologyNote?: string;
  claims: VerifiedClaim[];
  stages: StageTrace[];
  temperatures: Record<string, number>;
}> {
  const template = loadPromptTemplate(version, "verify.json");
  const safeClaim = sanitizeDelimiterTags(claimInput);
  const sourcesBlock =
    version === "V1"
      ? sources
          .map((s) => `[${s.id}] (${s.title}):\n${s.content}`)
          .join("\n\n")
      : formatSourcesBlock(sources);

  const renderedUserPrompt = renderPromptTemplate(template.userTemplate, {
    CLAIM_INPUT: safeClaim,
    SOURCES_INPUT: sourcesBlock,
  });

  const res = await llmCaller<SinglePassResponse>(
    template.systemPrompt,
    renderedUserPrompt,
    template.temperature
  );

  const stageTrace: StageTrace = {
    stageId: template.id,
    stageName: template.stage,
    templateId: template.id,
    temperature: template.temperature,
    systemPrompt: template.systemPrompt,
    renderedUserPrompt,
    rawOutput: res.rawText,
    latencyMs: res.latencyMs,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
  };

  const claims: VerifiedClaim[] = (res.data.claims ?? []).map((c, idx) => {
    const verdict = normalizeVerdict(c.verdict);
    const citations = validateCitations(c.citations, sources);
    const {
      confidence,
      reason,
      factualTruthConfidence,
      factualTruthNote,
    } = computeQualitativeConfidence({
      verdict,
      citations,
      verificationAgreement: "single_pass",
    });
    return {
      claimId: c.claimId || `C${idx + 1}`,
      claimText: c.claimText || claimInput,
      verdict,
      confidence,
      confidenceReason: reason,
      factualTruthConfidence,
      factualTruthNote,
      sourceCredibilityStatus: "Unverified User-Supplied Source",
      explanation: c.explanation || "No explanation provided.",
      citations,
      verificationAgreement: "single_pass",
      ...(verdict === "Insufficient Evidence" && (c.missingInformation || c.requiredEvidence)
        ? {
            missingInformation: c.missingInformation,
            requiredEvidence: c.requiredEvidence,
          }
        : {}),
    };
  });

  return {
    summary: res.data.summary || "Verification completed.",
    claims,
    stages: [stageTrace],
    temperatures: { [template.id]: template.temperature },
  };
}

async function runV3MultiStage(
  claimInput: string,
  sources: ReferenceSource[],
  llmCaller: StructuredLlmCaller,
  stage4Temperature?: number
): Promise<{
  summary: string;
  methodologyNote?: string;
  claims: VerifiedClaim[];
  stages: StageTrace[];
  temperatures: Record<string, number>;
}> {
  const t1 = loadPromptTemplate("V3", "01_claim_extraction.json");
  const t2 = loadPromptTemplate("V3", "02_evidence_analysis.json");
  const t3 = loadPromptTemplate("V3", "03_claim_verification.json");
  const t4 = loadPromptTemplate("V3", "04_independent_verification.json");
  const t4b = loadPromptTemplate("V3", "04b_disagreement_reviewer.json");
  const t5 = loadPromptTemplate("V3", "05_report_generation.json");

  const safeClaim = sanitizeDelimiterTags(claimInput);
  const sourcesBlock = formatSourcesBlock(sources);
  const stages: StageTrace[] = [];
  const temperatures: Record<string, number> = {};

  // Stage 1: Claim Extraction
  const u1 = renderPromptTemplate(t1.userTemplate, { CLAIM_INPUT: safeClaim });
  const r1 = await llmCaller<Stage1Response>(
    t1.systemPrompt,
    u1,
    t1.temperature
  );
  temperatures[t1.id] = t1.temperature;
  stages.push({
    stageId: t1.id,
    stageName: t1.stage,
    templateId: t1.id,
    temperature: t1.temperature,
    systemPrompt: t1.systemPrompt,
    renderedUserPrompt: u1,
    rawOutput: r1.rawText,
    latencyMs: r1.latencyMs,
    inputTokens: r1.inputTokens,
    outputTokens: r1.outputTokens,
  });

  const extractedClaims = r1.data.claims ?? [];
  const unresolvedClaimEntities = r1.data.unresolvedClaimEntities ?? [];
  if (extractedClaims.length === 0) {
    return {
      summary:
        "No independently verifiable factual claims were extracted from the input.",
      methodologyNote: r1.data.nonFactualNotes,
      claims: [],
      stages,
      temperatures,
    };
  }

  // Stage 2: Evidence Analysis
  const claimsJson = JSON.stringify(extractedClaims, null, 2);
  const unresolvedEntitiesJson = JSON.stringify(unresolvedClaimEntities, null, 2);
  const u2 = renderPromptTemplate(t2.userTemplate, {
    CLAIMS_JSON: claimsJson,
    UNRESOLVED_ENTITIES_JSON: unresolvedEntitiesJson,
    SOURCES_INPUT: sourcesBlock,
  });
  const r2 = await llmCaller<Stage2Response>(
    t2.systemPrompt,
    u2,
    t2.temperature
  );
  temperatures[t2.id] = t2.temperature;
  stages.push({
    stageId: t2.id,
    stageName: t2.stage,
    templateId: t2.id,
    temperature: t2.temperature,
    systemPrompt: t2.systemPrompt,
    renderedUserPrompt: u2,
    rawOutput: r2.rawText,
    latencyMs: r2.latencyMs,
    inputTokens: r2.inputTokens,
    outputTokens: r2.outputTokens,
  });

  // Stage 3: Claim Verification (uses extracted claims + Stage 2 evidence + identityResolution)
  const evidenceJson = JSON.stringify(
    {
      evidenceMap: r2.data.evidenceMap ?? [],
      identityResolution: r2.data.identityResolution ?? [],
    },
    null,
    2
  );
  const u3 = renderPromptTemplate(t3.userTemplate, {
    CLAIMS_JSON: claimsJson,
    EVIDENCE_JSON: evidenceJson,
  });
  const r3 = await llmCaller<Stage3Response>(
    t3.systemPrompt,
    u3,
    t3.temperature
  );
  temperatures[t3.id] = t3.temperature;
  stages.push({
    stageId: t3.id,
    stageName: t3.stage,
    templateId: t3.id,
    temperature: t3.temperature,
    systemPrompt: t3.systemPrompt,
    renderedUserPrompt: u3,
    rawOutput: r3.rawText,
    latencyMs: r3.latencyMs,
    inputTokens: r3.inputTokens,
    outputTokens: r3.outputTokens,
  });

  // Stage 4: Blind Independent Verification (NO access to Stage 3 verdicts)
  const s4Temperature = stage4Temperature !== undefined ? stage4Temperature : t4.temperature;
  const u4 = renderPromptTemplate(t4.userTemplate, {
    CLAIMS_JSON: claimsJson,
    SOURCES_INPUT: sourcesBlock,
  });
  const r4 = await llmCaller<Stage4BlindResponse>(
    t4.systemPrompt,
    u4,
    s4Temperature
  );
  temperatures[t4.id] = s4Temperature;
  stages.push({
    stageId: t4.id,
    stageName: t4.stage,
    templateId: t4.id,
    temperature: s4Temperature,
    systemPrompt: t4.systemPrompt,
    renderedUserPrompt: u4,
    rawOutput: r4.rawText,
    latencyMs: r4.latencyMs,
    inputTokens: r4.inputTokens,
    outputTokens: r4.outputTokens,
  });

  const s3Map = new Map(
    (r3.data.verifications ?? []).map((v) => [v.claimId, v])
  );
  const s4Map = new Map(
    (r4.data.independentVerifications ?? []).map((v) => [v.claimId, v])
  );

  // Identify only the claims where Stage 3 and Stage 4 disagree
  const disagreements = extractedClaims
    .map((ec, idx) => {
      const cid = ec.claimId || `C${idx + 1}`;
      const s3 = s3Map.get(cid);
      const s4 = s4Map.get(cid);
      const v3 = normalizeVerdict(s3?.verdict);
      const v4 = normalizeVerdict(s4?.verdict);
      if (v3 === v4) return null;
      return {
        claimId: cid,
        claimText: ec.claimText,
        stage3Position: {
          verdict: v3,
          explanation: s3?.explanation,
          citations: s3?.citations ?? [],
        },
        stage4Position: {
          verdict: v4,
          explanation: s4?.explanation,
          citations: s4?.citations ?? [],
        },
      };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);

  // Stage 4b: Separate Reviewer invoked ONLY when Stage 3 and Stage 4 disagree
  const adjudicationMap = new Map<
    string,
    NonNullable<Stage4bAdjudicationResponse["adjudications"]>[number]
  >();

  if (disagreements.length > 0) {
    const u4b = renderPromptTemplate(t4b.userTemplate, {
      DISAGREEMENTS_JSON: JSON.stringify(disagreements, null, 2),
      SOURCES_INPUT: sourcesBlock,
    });
    const r4b = await llmCaller<Stage4bAdjudicationResponse>(
      t4b.systemPrompt,
      u4b,
      t4b.temperature
    );
    temperatures[t4b.id] = t4b.temperature;
    stages.push({
      stageId: t4b.id,
      stageName: t4b.stage,
      templateId: t4b.id,
      temperature: t4b.temperature,
      systemPrompt: t4b.systemPrompt,
      renderedUserPrompt: u4b,
      rawOutput: r4b.rawText,
      latencyMs: r4b.latencyMs,
      inputTokens: r4b.inputTokens,
      outputTokens: r4b.outputTokens,
    });

    for (const adj of r4b.data.adjudications ?? []) {
      if (adj.claimId) {
        adjudicationMap.set(adj.claimId, adj);
      }
    }
  }

  // Build finalized claims with deterministic citation validation and qualitative confidence
  const claims: VerifiedClaim[] = extractedClaims.map((ec, idx) => {
    const cid = ec.claimId || `C${idx + 1}`;
    const s3 = s3Map.get(cid);
    const s4 = s4Map.get(cid);
    const adj = adjudicationMap.get(cid);

    const stage3Verdict = normalizeVerdict(s3?.verdict);
    const stage4Verdict = normalizeVerdict(s4?.verdict);
    const agreed = stage3Verdict === stage4Verdict;
    const verificationAgreement = agreed ? "agreed" : "disagreed_reconciled";

    const finalVerdict = adj
      ? normalizeVerdict(adj.finalVerdict)
      : stage3Verdict;

    const finalExplanation = adj?.finalExplanation
      ? adj.finalExplanation
      : agreed
        ? s3?.explanation || s4?.explanation || "No explanation provided."
        : s3?.explanation || "No explanation provided.";

    const rawCitations = adj?.finalCitations
      ? adj.finalCitations
      : [...(s3?.citations ?? []), ...(s4?.citations ?? [])].filter(
          (c, i, arr) =>
            arr.findIndex(
              (x) => x.sourceId === c.sourceId && x.quote === c.quote
            ) === i
        );

    const citations = validateCitations(rawCitations, sources);
    const evidenceSupportsVerdict = adj?.evidenceSupportsVerdict;

    const {
      confidence,
      reason,
      factualTruthConfidence,
      factualTruthNote,
    } = computeQualitativeConfidence({
      verdict: finalVerdict,
      citations,
      verificationAgreement,
      evidenceSupportsVerdict,
    });

    return {
      claimId: cid,
      claimText: ec.claimText || s3?.claimText || "",
      verdict: finalVerdict,
      confidence,
      confidenceReason: reason,
      factualTruthConfidence,
      factualTruthNote,
      sourceCredibilityStatus: "Unverified User-Supplied Source",
      explanation: finalExplanation,
      citations,
      verificationAgreement,
      stage3Verdict,
      stage4Verdict,
      // For Insufficient Evidence: propagate missing information from Stage 3 or Stage 4
      ...(finalVerdict === "Insufficient Evidence"
        ? {
            missingInformation:
              adj?.finalExplanation
                ? undefined
                : s3?.missingInformation || s4?.missingInformation,
            requiredEvidence:
              adj?.finalExplanation
                ? undefined
                : s3?.requiredEvidence || s4?.requiredEvidence,
          }
        : {}),
      evidenceAlignment: adj
        ? {
            assessed: true,
            supportsVerdict: adj.evidenceSupportsVerdict ?? true,
            note: adj.alignmentNote || "Adjudicated by Stage 4b reviewer.",
          }
        : undefined,
    };
  });

  // Stage 5: Report Generation
  const u5 = renderPromptTemplate(t5.userTemplate, {
    FINAL_CLAIMS_JSON: JSON.stringify(
      claims.map((c) => ({
        claimId: c.claimId,
        claimText: c.claimText,
        verdict: c.verdict,
        confidence: c.confidence,
        verificationAgreement: c.verificationAgreement,
        verifiedCitationCount: c.citations.filter((x) => x.verified).length,
        totalCitationCount: c.citations.length,
        // Pass missingInformation and requiredEvidence for Insufficient Evidence verdicts
        ...(c.missingInformation ? { missingInformation: c.missingInformation } : {}),
        ...(c.requiredEvidence ? { requiredEvidence: c.requiredEvidence } : {}),
      })),
      null,
      2
    ),
  });
  const r5 = await llmCaller<Stage5Response>(
    t5.systemPrompt,
    u5,
    t5.temperature
  );
  temperatures[t5.id] = t5.temperature;
  stages.push({
    stageId: t5.id,
    stageName: t5.stage,
    templateId: t5.id,
    temperature: t5.temperature,
    systemPrompt: t5.systemPrompt,
    renderedUserPrompt: u5,
    rawOutput: r5.rawText,
    latencyMs: r5.latencyMs,
    inputTokens: r5.inputTokens,
    outputTokens: r5.outputTokens,
  });

  return {
    summary: r5.data.summary || "Multi-stage verification complete.",
    methodologyNote: r5.data.methodologyNote,
    claims,
    stages,
    temperatures,
  };
}

export async function runVerification(
  version: PromptVersion,
  claimInput: string,
  sources: ReferenceSource[],
  llmCaller: StructuredLlmCaller = callStructuredJson,
  options?: { stage4Temperature?: number }
): Promise<VerificationRun> {
  const injectionScan = scanForPromptInjection([
    claimInput,
    ...sources.map((s) => s.content),
  ]);

  const result =
    version === "V3"
      ? await runV3MultiStage(claimInput, sources, llmCaller, options?.stage4Temperature)
      : await runSinglePass(version, claimInput, sources, llmCaller);

  const metrics = computeRunMetrics(result.claims, result.stages);

  return {
    runId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    version,
    modelConfig: {
      model: getModelName(),
      temperatures: result.temperatures,
    },
    claimInput,
    sources: sources.map((s) => ({
      id: s.id,
      title: s.title,
      type: s.type,
      charCount: s.charCount,
    })),
    injectionScan,
    summary: result.summary,
    methodologyNote: result.methodologyNote,
    claims: result.claims,
    stages: result.stages,
    metrics,
  };
}
