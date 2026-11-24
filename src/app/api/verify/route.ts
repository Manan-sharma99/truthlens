import { NextResponse } from "next/server";
import { LlmParseError, MissingApiKeyError, RateLimitError } from "@/lib/llm";
import { runVerification } from "@/lib/pipeline";
import { saveVerificationRun } from "@/lib/storage";
import type { PromptVersion, ReferenceSource } from "@/lib/types";

interface VerifyRequestBody {
  version?: PromptVersion | "ALL";
  claimInput?: string;
  sources?: ReferenceSource[];
  stage4Temperature?: number;
}

export async function POST(req: Request) {
  try {
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

    const validSources = sources.filter(
      (s) => s && typeof s.content === "string" && s.content.trim().length > 0
    );

    if (validSources.length === 0) {
      return NextResponse.json(
        { error: "Please provide at least one non-empty reference source." },
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
      saveVerificationRun(run);
      runs.push(run);
    }

    return NextResponse.json({ runs });
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
