import { NextResponse } from "next/server";
import {
  clearPersistedData,
  getPersistedData,
  loadEvalBenchmark,
  loadPromptIterations,
} from "@/lib/storage";

export async function GET() {
  try {
    const store = getPersistedData();
    const benchmarkCases = loadEvalBenchmark();
    const promptIterations = loadPromptIterations();
    return NextResponse.json({
      verificationRuns: store.verificationRuns,
      evalRuns: store.evalRuns,
      appValidationResults: store.appValidationResults,
      benchmarkCases,
      promptIterations,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to load stored runs.",
      },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    clearPersistedData();
    return NextResponse.json({ cleared: true });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to clear stored runs.",
      },
      { status: 500 }
    );
  }
}
