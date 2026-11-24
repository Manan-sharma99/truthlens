import { NextResponse } from "next/server";
import { isReadOnlyProduction } from "@/lib/runtime";
import {
  clearPersistedData,
  getPersistedData,
  loadEvalBenchmark,
  loadPromptIterations,
  loadTemperatureExperiment,
} from "@/lib/storage";

export async function GET() {
  try {
    const readOnlyProduction = isReadOnlyProduction();
    const store = getPersistedData();
    const benchmarkCases = loadEvalBenchmark();
    const promptIterations = loadPromptIterations();
    const temperatureExperiment = loadTemperatureExperiment();
    return NextResponse.json({
      verificationRuns: store.verificationRuns,
      evalRuns: store.evalRuns,
      appValidationResults: store.appValidationResults,
      benchmarkCases,
      promptIterations,
      temperatureExperiment,
      readOnlyProduction,
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
  if (isReadOnlyProduction()) {
    return NextResponse.json(
      {
        error:
          "Read-only production mode: historical academic records cannot be modified or deleted.",
      },
      { status: 403 }
    );
  }
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
