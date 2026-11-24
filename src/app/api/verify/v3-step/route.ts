import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { scanForPromptInjection } from "@/lib/injection-guard";
import { getModelName } from "@/lib/llm";
import {
  buildV3Disagreements,
  executeV3Stage1,
  executeV3Stage2,
  executeV3Stage3,
  executeV3Stage4,
  executeV3Stage4b,
  executeV3Stage5AndBuildRun,
  type ExtractedClaimItem,
  type Stage2Response,
  type Stage3Response,
  type Stage4bAdjudicationResponse,
  type Stage4BlindResponse,
  type UnresolvedClaimEntity,
  type V3DisagreementItem,
} from "@/lib/pipeline";
import { isReadOnlyProduction } from "@/lib/runtime";
import { saveVerificationRun } from "@/lib/storage";
import type { ReferenceSource, StageTrace, VerificationRun } from "@/lib/types";
import {
  enforceVerifyRateLimit,
  mapVerifyErrorToJsonResponse,
  validateAndNormalizeVerifyInputs,
} from "@/lib/verify-http";

export const maxDuration = 60;

type V3StepName = "stage1" | "stage2" | "stage3" | "stage4" | "stage4b" | "stage5";

interface V3StepRequestBody {
  step?: V3StepName;
  claimInput?: string;
  sources?: ReferenceSource[];
  stage4Temperature?: number;
  extractedClaims?: ExtractedClaimItem[];
  unresolvedClaimEntities?: UnresolvedClaimEntity[];
  stage2Data?: Stage2Response;
  stage3Data?: Stage3Response;
  stage4Data?: Stage4BlindResponse;
  stage4bData?: Stage4bAdjudicationResponse;
  disagreements?: V3DisagreementItem[];
  priorTraces?: StageTrace[];
  temperatures?: Record<string, number>;
}

/**
 * Executes a single V3 stage per HTTP invocation so each Gemini API call
 * receives its own Vercel serverless duration budget without hitting 504 timeouts.
 */
export async function POST(req: Request) {
  try {
    const rateLimited = enforceVerifyRateLimit(req);
    if (rateLimited) return rateLimited;

    const body = (await req.json()) as V3StepRequestBody;
    const step = body.step;
    if (
      step !== "stage1" &&
      step !== "stage2" &&
      step !== "stage3" &&
      step !== "stage4" &&
      step !== "stage4b" &&
      step !== "stage5"
    ) {
      return NextResponse.json(
        { error: "Invalid V3 step specified.", code: "INVALID_STEP" },
        { status: 400 }
      );
    }

    const validated = validateAndNormalizeVerifyInputs(
      body.claimInput,
      body.sources
    );
    if (!validated.ok) return validated.response;

    const { claimInput, sources } = validated;
    const readOnlyProduction = isReadOnlyProduction();

    if (step === "stage1") {
      const injectionScan = scanForPromptInjection([
        claimInput,
        ...sources.map((s) => s.content),
      ]);
      const s1Res = await executeV3Stage1(claimInput);
      const extractedClaims = s1Res.data.claims ?? [];
      const unresolvedClaimEntities = s1Res.data.unresolvedClaimEntities ?? [];

      if (extractedClaims.length === 0) {
        const emptyRun: VerificationRun = {
          runId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          version: "V3",
          modelConfig: {
            model: getModelName(),
            temperatures: { [s1Res.templateId]: s1Res.temperature },
          },
          claimInput,
          sources: sources.map((s) => ({
            id: s.id,
            title: s.title,
            type: s.type,
            charCount: s.charCount,
          })),
          injectionScan,
          summary:
            "No independently verifiable factual claims were extracted from the input.",
          methodologyNote: s1Res.data.nonFactualNotes,
          claims: [],
          stages: [s1Res.trace],
          metrics: {
            totalLatencyMs: s1Res.trace.latencyMs,
            totalInputTokens: s1Res.trace.inputTokens,
            totalOutputTokens: s1Res.trace.outputTokens,
            totalCitations: 0,
            verifiedCitations: 0,
            citationValidityRate: 1,
            disagreementCount: 0,
          },
        };
        if (!readOnlyProduction) saveVerificationRun(emptyRun);
        return NextResponse.json({ done: true, run: emptyRun });
      }

      return NextResponse.json({
        done: false,
        injectionScan,
        extractedClaims,
        unresolvedClaimEntities,
        trace: s1Res.trace,
        templateId: s1Res.templateId,
        temperature: s1Res.temperature,
      });
    }

    const extractedClaims = Array.isArray(body.extractedClaims)
      ? body.extractedClaims
      : [];
    if (extractedClaims.length === 0) {
      return NextResponse.json(
        { error: "Missing extractedClaims from Stage 1.", code: "INVALID_STATE" },
        { status: 400 }
      );
    }

    if (step === "stage2") {
      const s2Res = await executeV3Stage2(
        extractedClaims,
        body.unresolvedClaimEntities ?? [],
        sources
      );
      return NextResponse.json({
        stage2Data: s2Res.data,
        trace: s2Res.trace,
        templateId: s2Res.templateId,
        temperature: s2Res.temperature,
      });
    }

    if (step === "stage3") {
      if (!body.stage2Data) {
        return NextResponse.json(
          { error: "Missing stage2Data for Stage 3.", code: "INVALID_STATE" },
          { status: 400 }
        );
      }
      const s3Res = await executeV3Stage3(extractedClaims, body.stage2Data);
      return NextResponse.json({
        stage3Data: s3Res.data,
        trace: s3Res.trace,
        templateId: s3Res.templateId,
        temperature: s3Res.temperature,
      });
    }

    if (step === "stage4") {
      // Blind independent verifier: receives extractedClaims + sources ONLY
      const stage4Temp =
        typeof body.stage4Temperature === "number"
          ? body.stage4Temperature
          : undefined;
      const s4Res = await executeV3Stage4(
        extractedClaims,
        sources,
        undefined,
        stage4Temp
      );
      return NextResponse.json({
        stage4Data: s4Res.data,
        trace: s4Res.trace,
        templateId: s4Res.templateId,
        temperature: s4Res.temperature,
      });
    }

    if (step === "stage4b") {
      const disagreements =
        body.disagreements && body.disagreements.length > 0
          ? body.disagreements
          : body.stage3Data && body.stage4Data
            ? buildV3Disagreements(
                extractedClaims,
                body.stage3Data,
                body.stage4Data
              )
            : [];
      if (disagreements.length === 0) {
        return NextResponse.json({
          skipped: true,
          stage4bData: { adjudications: [] },
        });
      }
      const s4bRes = await executeV3Stage4b(disagreements, sources);
      return NextResponse.json({
        skipped: false,
        stage4bData: s4bRes.data,
        trace: s4bRes.trace,
        templateId: s4bRes.templateId,
        temperature: s4bRes.temperature,
      });
    }

    // step === "stage5"
    if (!body.stage3Data || !body.stage4Data) {
      return NextResponse.json(
        {
          error: "Missing stage3Data or stage4Data for Stage 5.",
          code: "INVALID_STATE",
        },
        { status: 400 }
      );
    }

    const injectionScan = scanForPromptInjection([
      claimInput,
      ...sources.map((s) => s.content),
    ]);

    const run = await executeV3Stage5AndBuildRun({
      claimInput,
      sources,
      injectionScan,
      extractedClaims,
      stage3Data: body.stage3Data,
      stage4Data: body.stage4Data,
      stage4bData: body.stage4bData,
      priorTraces: body.priorTraces ?? [],
      temperatures: body.temperatures ?? {},
    });

    if (!readOnlyProduction) {
      saveVerificationRun(run);
    }

    return NextResponse.json({
      done: true,
      run,
      storageMode: readOnlyProduction ? "session_only" : "local_json",
    });
  } catch (err) {
    return mapVerifyErrorToJsonResponse(err);
  }
}
