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
  InjectionScanResult,
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

export interface UnresolvedClaimEntity {
  entityRef?: string;
  reason?: string;
}

export interface IdentityResolution {
  entityRef?: string;
  resolution?: string;
  detail?: string;
}

export interface ExtractedClaimItem {
  claimId?: string;
  claimText?: string;
  originalSpan?: string;
  claimType?: string;
  inputForm?: string;
}

export interface Stage1Response {
  claims?: ExtractedClaimItem[];
  unresolvedClaimEntities?: UnresolvedClaimEntity[];
  nonFactualNotes?: string;
}

export interface Stage2Response {
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

export interface Stage3Response {
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

export interface Stage4BlindResponse {
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

export interface Stage4bAdjudicationResponse {
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

export interface V3DisagreementItem {
  claimId: string;
  claimText: string | undefined;
  stage3Position: {
    verdict: Verdict;
    explanation: string | undefined;
    citations: RawCitation[];
  };
  stage4Position: {
    verdict: Verdict;
    explanation: string | undefined;
    citations: RawCitation[];
  };
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

function makeStageTrace(
  tpl: { id: string; stage: string },
  temperature: number,
  renderedUserPrompt: string,
  systemPrompt: string,
  res: LlmJsonResponse<unknown>
): StageTrace {
  return {
    stageId: tpl.id,
    stageName: tpl.stage,
    templateId: tpl.id,
    temperature,
    systemPrompt,
    renderedUserPrompt,
    rawOutput: res.rawText,
    latencyMs: res.latencyMs,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
  };
}

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

  const stageTrace = makeStageTrace(
    template,
    template.temperature,
    renderedUserPrompt,
    template.systemPrompt,
    res
  );

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
      ...(verdict === "Insufficient Evidence" &&
      (c.missingInformation || c.requiredEvidence)
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

export async function executeV3Stage1(
  claimInput: string,
  llmCaller: StructuredLlmCaller = callStructuredJson
): Promise<{
  data: Stage1Response;
  trace: StageTrace;
  templateId: string;
  temperature: number;
}> {
  const t1 = loadPromptTemplate("V3", "01_claim_extraction.json");
  const safeClaim = sanitizeDelimiterTags(claimInput);
  const u1 = renderPromptTemplate(t1.userTemplate, { CLAIM_INPUT: safeClaim });
  const r1 = await llmCaller<Stage1Response>(
    t1.systemPrompt,
    u1,
    t1.temperature
  );
  return {
    data: r1.data,
    trace: makeStageTrace(t1, t1.temperature, u1, t1.systemPrompt, r1),
    templateId: t1.id,
    temperature: t1.temperature,
  };
}

export async function executeV3Stage2(
  extractedClaims: ExtractedClaimItem[],
  unresolvedClaimEntities: UnresolvedClaimEntity[],
  sources: ReferenceSource[],
  llmCaller: StructuredLlmCaller = callStructuredJson
): Promise<{
  data: Stage2Response;
  trace: StageTrace;
  templateId: string;
  temperature: number;
}> {
  const t2 = loadPromptTemplate("V3", "02_evidence_analysis.json");
  const claimsJson = JSON.stringify(extractedClaims, null, 2);
  const unresolvedEntitiesJson = JSON.stringify(
    unresolvedClaimEntities,
    null,
    2
  );
  const sourcesBlock = formatSourcesBlock(sources);
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
  return {
    data: r2.data,
    trace: makeStageTrace(t2, t2.temperature, u2, t2.systemPrompt, r2),
    templateId: t2.id,
    temperature: t2.temperature,
  };
}

export async function executeV3Stage3(
  extractedClaims: ExtractedClaimItem[],
  stage2Data: Stage2Response,
  llmCaller: StructuredLlmCaller = callStructuredJson
): Promise<{
  data: Stage3Response;
  trace: StageTrace;
  templateId: string;
  temperature: number;
}> {
  const t3 = loadPromptTemplate("V3", "03_claim_verification.json");
  const claimsJson = JSON.stringify(extractedClaims, null, 2);
  const evidenceJson = JSON.stringify(
    {
      evidenceMap: stage2Data.evidenceMap ?? [],
      identityResolution: stage2Data.identityResolution ?? [],
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
  return {
    data: r3.data,
    trace: makeStageTrace(t3, t3.temperature, u3, t3.systemPrompt, r3),
    templateId: t3.id,
    temperature: t3.temperature,
  };
}

/**
 * Stage 4: Blind Independent Verification — strictly receives extracted claims + raw sources ONLY.
 * Never receives Stage 2 or Stage 3 outputs.
 */
export async function executeV3Stage4(
  extractedClaims: ExtractedClaimItem[],
  sources: ReferenceSource[],
  llmCaller: StructuredLlmCaller = callStructuredJson,
  stage4Temperature?: number
): Promise<{
  data: Stage4BlindResponse;
  trace: StageTrace;
  templateId: string;
  temperature: number;
}> {
  const t4 = loadPromptTemplate("V3", "04_independent_verification.json");
  const s4Temperature =
    stage4Temperature !== undefined ? stage4Temperature : t4.temperature;
  const claimsJson = JSON.stringify(extractedClaims, null, 2);
  const sourcesBlock = formatSourcesBlock(sources);
  const u4 = renderPromptTemplate(t4.userTemplate, {
    CLAIMS_JSON: claimsJson,
    SOURCES_INPUT: sourcesBlock,
  });
  const r4 = await llmCaller<Stage4BlindResponse>(
    t4.systemPrompt,
    u4,
    s4Temperature
  );
  return {
    data: r4.data,
    trace: makeStageTrace(t4, s4Temperature, u4, t4.systemPrompt, r4),
    templateId: t4.id,
    temperature: s4Temperature,
  };
}

export function buildV3Disagreements(
  extractedClaims: ExtractedClaimItem[],
  stage3Data: Stage3Response,
  stage4Data: Stage4BlindResponse
): V3DisagreementItem[] {
  const s3Map = new Map(
    (stage3Data.verifications ?? []).map((v) => [v.claimId, v])
  );
  const s4Map = new Map(
    (stage4Data.independentVerifications ?? []).map((v) => [v.claimId, v])
  );

  return extractedClaims
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
}

export async function executeV3Stage4b(
  disagreements: V3DisagreementItem[],
  sources: ReferenceSource[],
  llmCaller: StructuredLlmCaller = callStructuredJson
): Promise<{
  data: Stage4bAdjudicationResponse;
  trace: StageTrace;
  templateId: string;
  temperature: number;
}> {
  const t4b = loadPromptTemplate("V3", "04b_disagreement_reviewer.json");
  const sourcesBlock = formatSourcesBlock(sources);
  const u4b = renderPromptTemplate(t4b.userTemplate, {
    DISAGREEMENTS_JSON: JSON.stringify(disagreements, null, 2),
    SOURCES_INPUT: sourcesBlock,
  });
  const r4b = await llmCaller<Stage4bAdjudicationResponse>(
    t4b.systemPrompt,
    u4b,
    t4b.temperature
  );
  return {
    data: r4b.data,
    trace: makeStageTrace(t4b, t4b.temperature, u4b, t4b.systemPrompt, r4b),
    templateId: t4b.id,
    temperature: t4b.temperature,
  };
}

export function finalizeV3Claims(
  extractedClaims: ExtractedClaimItem[],
  stage3Data: Stage3Response,
  stage4Data: Stage4BlindResponse,
  stage4bData: Stage4bAdjudicationResponse | undefined,
  sources: ReferenceSource[]
): VerifiedClaim[] {
  const s3Map = new Map(
    (stage3Data.verifications ?? []).map((v) => [v.claimId, v])
  );
  const s4Map = new Map(
    (stage4Data.independentVerifications ?? []).map((v) => [v.claimId, v])
  );
  const adjudicationMap = new Map(
    (stage4bData?.adjudications ?? [])
      .filter((a) => Boolean(a.claimId))
      .map((a) => [a.claimId!, a])
  );

  return extractedClaims.map((ec, idx) => {
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
      ...(finalVerdict === "Insufficient Evidence"
        ? {
            missingInformation: adj?.finalExplanation
              ? undefined
              : s3?.missingInformation || s4?.missingInformation,
            requiredEvidence: adj?.finalExplanation
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
}

export async function executeV3Stage5AndBuildRun(params: {
  claimInput: string;
  sources: ReferenceSource[];
  injectionScan: InjectionScanResult;
  extractedClaims: ExtractedClaimItem[];
  stage3Data: Stage3Response;
  stage4Data: Stage4BlindResponse;
  stage4bData?: Stage4bAdjudicationResponse;
  priorTraces: StageTrace[];
  temperatures: Record<string, number>;
  llmCaller?: StructuredLlmCaller;
}): Promise<VerificationRun> {
  const llmCaller = params.llmCaller ?? callStructuredJson;
  const claims = finalizeV3Claims(
    params.extractedClaims,
    params.stage3Data,
    params.stage4Data,
    params.stage4bData,
    params.sources
  );

  const t5 = loadPromptTemplate("V3", "05_report_generation.json");
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
        ...(c.missingInformation
          ? { missingInformation: c.missingInformation }
          : {}),
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
  const s5Trace = makeStageTrace(t5, t5.temperature, u5, t5.systemPrompt, r5);
  const stages = [...params.priorTraces, s5Trace];
  const temperatures = {
    ...params.temperatures,
    [t5.id]: t5.temperature,
  };
  const metrics = computeRunMetrics(claims, stages);

  return {
    runId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    version: "V3",
    modelConfig: {
      model: getModelName(),
      temperatures,
    },
    claimInput: params.claimInput,
    sources: params.sources.map((s) => ({
      id: s.id,
      title: s.title,
      type: s.type,
      charCount: s.charCount,
    })),
    injectionScan: params.injectionScan,
    summary: r5.data.summary || "Multi-stage verification complete.",
    methodologyNote: r5.data.methodologyNote,
    claims,
    stages,
    metrics,
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
  const temperatures: Record<string, number> = {};

  // Stage 1: Claim Extraction
  const s1Res = await executeV3Stage1(claimInput, llmCaller);
  temperatures[s1Res.templateId] = s1Res.temperature;

  const extractedClaims = s1Res.data.claims ?? [];
  const unresolvedClaimEntities = s1Res.data.unresolvedClaimEntities ?? [];
  if (extractedClaims.length === 0) {
    return {
      summary:
        "No independently verifiable factual claims were extracted from the input.",
      methodologyNote: s1Res.data.nonFactualNotes,
      claims: [],
      stages: [s1Res.trace],
      temperatures,
    };
  }

  // Run Stage 2 -> Stage 3 in parallel with Blind Stage 4 (Stage 4 never sees Stage 2 or Stage 3)
  const [s2AndS3, s4Res] = await Promise.all([
    (async () => {
      const s2Res = await executeV3Stage2(
        extractedClaims,
        unresolvedClaimEntities,
        sources,
        llmCaller
      );
      const s3Res = await executeV3Stage3(
        extractedClaims,
        s2Res.data,
        llmCaller
      );
      return { s2Res, s3Res };
    })(),
    executeV3Stage4(extractedClaims, sources, llmCaller, stage4Temperature),
  ]);

  const { s2Res, s3Res } = s2AndS3;
  temperatures[s2Res.templateId] = s2Res.temperature;
  temperatures[s3Res.templateId] = s3Res.temperature;
  temperatures[s4Res.templateId] = s4Res.temperature;

  const stages: StageTrace[] = [
    s1Res.trace,
    s2Res.trace,
    s3Res.trace,
    s4Res.trace,
  ];

  // Stage 4b: Separate Reviewer invoked ONLY when Stage 3 and Stage 4 disagree
  const disagreements = buildV3Disagreements(
    extractedClaims,
    s3Res.data,
    s4Res.data
  );
  let stage4bData: Stage4bAdjudicationResponse | undefined;

  if (disagreements.length > 0) {
    const s4bRes = await executeV3Stage4b(disagreements, sources, llmCaller);
    temperatures[s4bRes.templateId] = s4bRes.temperature;
    stages.push(s4bRes.trace);
    stage4bData = s4bRes.data;
  }

  // Stage 5: Finalize claims + Report Generation
  const finalizedRun = await executeV3Stage5AndBuildRun({
    claimInput,
    sources,
    injectionScan: { flagged: false, warnings: [] },
    extractedClaims,
    stage3Data: s3Res.data,
    stage4Data: s4Res.data,
    stage4bData,
    priorTraces: stages,
    temperatures,
    llmCaller,
  });

  return {
    summary: finalizedRun.summary,
    methodologyNote: finalizedRun.methodologyNote,
    claims: finalizedRun.claims,
    stages: finalizedRun.stages,
    temperatures: finalizedRun.modelConfig.temperatures,
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
      ? await runV3MultiStage(
          claimInput,
          sources,
          llmCaller,
          options?.stage4Temperature
        )
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
