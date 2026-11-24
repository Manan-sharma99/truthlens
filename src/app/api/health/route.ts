import { NextResponse } from "next/server";
import { getModelName, isApiConfigured } from "@/lib/llm";
import { isReadOnlyProduction } from "@/lib/runtime";

export async function GET() {
  const readOnlyProduction = isReadOnlyProduction();
  return NextResponse.json({
    configured: isApiConfigured(),
    model: getModelName(),
    readOnlyProduction,
    storageMode: readOnlyProduction ? "session_only" : "local_json",
  });
}
