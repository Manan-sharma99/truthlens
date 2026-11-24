import { NextResponse } from "next/server";
import { runBenchmarkEvaluation } from "@/lib/evaluator";
import { isReadOnlyProduction } from "@/lib/runtime";
import type { EvalMode, EvalSplit, PromptVersion } from "@/lib/types";
import { mapVerifyErrorToJsonResponse } from "@/lib/verify-http";

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
    return mapVerifyErrorToJsonResponse(err, "Evaluation request failed.");
  }
}
