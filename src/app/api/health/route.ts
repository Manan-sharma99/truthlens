import { NextResponse } from "next/server";
import { getModelName, isApiConfigured } from "@/lib/llm";

export async function GET() {
  return NextResponse.json({
    configured: isApiConfigured(),
    model: getModelName(),
  });
}
