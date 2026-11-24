import { NextResponse } from "next/server";
import { LlmParseError, MissingApiKeyError, RateLimitError } from "@/lib/llm";
import { runVerification } from "@/lib/pipeline";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { isReadOnlyProduction } from "@/lib/runtime";
import { saveVerificationRun } from "@/lib/storage";
import type { PromptVersion, ReferenceSource } from "@/lib/types";

export const maxDuration = 60;

const MAX_CLAIM_CHARS = 8000;
const MAX_SOURCES_COUNT = 6;
const MAX_TOTAL_SOURCE_CHARS = 40000;

interface VerifyRequestBody {
  version?: PromptVersion | "ALL";
  claimInput?: string;
  sources?: ReferenceSource[];
  stage4Temperature?: number;
}

export async function POST(req: Request) {
  try {
    const readOnlyProduction = isReadOnlyProduction();

    if (readOnlyProduction) {
      const ip = getClientIp(req);
      const limit = checkRateLimit(`verify:${ip}`, 12, 60_000);
      if (!limit.allowed) {
        return NextResponse.json(
          {
            error: `Rate limit exceeded for live verification. Please retry in ${limit.retryAfterSec}s.`,
          },
          {
            status: 429,
            headers: { "Retry-After": String(limit.retryAfterSec) },
          }
        );
      }
    }

    const body = (await req.json()) as VerifyRequestBody;
    const claimInput = (body.claimInput ?? "").trim();
    const sources = Array.isArray(body.sources) ? body.sources : [];
    const version = body.version ?? "V3";

    if (!claimInput) {
      return NextResponse.json(
        { error: "Please enter a claim or statement to verify." },
        { status: 400 }
      );
    }

    if (claimInput.length > MAX_CLAIM_CHARS) {
      return NextResponse.json(
        {
          error: `Claim input exceeds maximum length of ${MAX_CLAIM_CHARS} characters.`,
        },
        { status: 400 }
      );
    }

    const validSources = sources.filter(
      (s) => s && typeof s.content === "string" && s.content.trim().length > 0
    );

    if (validSources.length === 0) {
      return NextResponse.json(
        { error: "Please provide at least one non-empty reference source." },
        { status: 400 }
      );
    }

    if (validSources.length > MAX_SOURCES_COUNT) {
      return NextResponse.json(
        {
          error: `At most ${MAX_SOURCES_COUNT} reference sources are allowed per request.`,
        },
        { status: 400 }
      );
    }

    const totalSourceChars = validSources.reduce(
      (sum, s) => sum + s.content.trim().length,
      0
    );
    if (totalSourceChars > MAX_TOTAL_SOURCE_CHARS) {
      return NextResponse.json(
        {
          error: `Combined reference text exceeds ${MAX_TOTAL_SOURCE_CHARS} characters.`,
        },
        { status: 400 }
      );
    }

    const normalizedSources: ReferenceSource[] = validSources.map((s, idx) => ({
      id: s.id?.trim() || `S${idx + 1}`,
      title: s.title?.trim() || `Source ${idx + 1}`,
      type: s.type || "text",
      content: s.content.trim(),
      charCount: s.content.trim().length,
    }));

    const versionsToRun: PromptVersion[] =
      version === "ALL" ? ["V1", "V2", "V3"] : [version];

    const stage4Temp =
      typeof body.stage4Temperature === "number" ? body.stage4Temperature : undefined;

    const runs = [];
    for (const v of versionsToRun) {
      const run = await runVerification(v, claimInput, normalizedSources, undefined, {
        stage4Temperature: stage4Temp,
      });
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
    if (err instanceof MissingApiKeyError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof RateLimitError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    if (err instanceof LlmParseError) {
      return NextResponse.json(
        { error: err.message, rawText: err.rawText },
        { status: 502 }
      );
    }
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Verification request failed.",
      },
      { status: 500 }
    );
  }
}
