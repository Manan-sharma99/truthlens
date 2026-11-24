import { NextResponse } from "next/server";
import { runVerification } from "@/lib/pipeline";
import { isReadOnlyProduction } from "@/lib/runtime";
import { saveVerificationRun } from "@/lib/storage";
import type { PromptVersion, ReferenceSource } from "@/lib/types";
import {
  enforceVerifyRateLimit,
  mapVerifyErrorToJsonResponse,
  validateAndNormalizeVerifyInputs,
} from "@/lib/verify-http";

export const maxDuration = 60;

interface VerifyRequestBody {
  version?: PromptVersion | "ALL";
  claimInput?: string;
  sources?: ReferenceSource[];
  stage4Temperature?: number;
}

export async function POST(req: Request) {
  try {
    const rateLimited = enforceVerifyRateLimit(req);
    if (rateLimited) return rateLimited;

    const body = (await req.json()) as VerifyRequestBody;
    const validated = validateAndNormalizeVerifyInputs(
      body.claimInput,
      body.sources
    );
    if (!validated.ok) return validated.response;

    const readOnlyProduction = isReadOnlyProduction();
    const version = body.version ?? "V3";
    const versionsToRun: PromptVersion[] =
      version === "ALL" ? ["V1", "V2", "V3"] : [version];

    const stage4Temp =
      typeof body.stage4Temperature === "number"
        ? body.stage4Temperature
        : undefined;

    const runs = [];
    for (const v of versionsToRun) {
      const run = await runVerification(
        v,
        validated.claimInput,
        validated.sources,
        undefined,
        { stage4Temperature: stage4Temp }
      );
      if (!readOnlyProduction) {
        saveVerificationRun(run);
      }
      runs.push(run);
    }

    return NextResponse.json({
      runs,
      storageMode: readOnlyProduction ? "session_only" : "local_json",
    });
  } catch (err) {
    return mapVerifyErrorToJsonResponse(err);
  }
}
