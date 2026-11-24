import { NextResponse } from "next/server";
import { runBenchmarkEvaluation } from "@/lib/evaluator";
import { LlmParseError, MissingApiKeyError, RateLimitError } from "@/lib/llm";
import { isReadOnlyProduction } from "@/lib/runtime";
import type { EvalMode, EvalSplit, PromptVersion } from "@/lib/types";

export const maxDuration = 60;

interface EvaluateRequestBody {
  version?: PromptVersion | "ALL";
  evalMode?: EvalMode | "all";
  splitFilter?: EvalSplit | "all";
  caseIds?: string[];
  stage4Temperature?: number;
  resume?: boolean;
}

export async function POST(req: Request) {
  if (isReadOnlyProduction()) {
    return NextResponse.json(
      {
        error:
          "Live benchmark batch execution is disabled in read-only production to prevent API quota exhaustion. Historical evaluation records and exports remain available below.",
      },
      { status: 403 }
    );
  }

  try {
    const body = (await req.json()) as EvaluateRequestBody;
    const version = body.version ?? "ALL";
    const versions: PromptVersion[] =
      version === "ALL" ? ["V1", "V2", "V3"] : [version];

    const evalRuns = [];
    for (const v of versions) {
      const res = await runBenchmarkEvaluation(v, {
        caseIds: body.caseIds,
        splitFilter: body.splitFilter ?? "all",
        evalMode: body.evalMode ?? "all",
        stage4Temperature: body.stage4Temperature,
        resume: body.resume,
      });
      evalRuns.push(res);
    }

    return NextResponse.json({ evalRuns });
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
          err instanceof Error ? err.message : "Evaluation request failed.",
      },
      { status: 500 }
    );
  }
}
