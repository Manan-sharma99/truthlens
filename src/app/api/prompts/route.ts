import { NextResponse } from "next/server";
import { listAllPromptTemplates } from "@/lib/prompt-loader";

export async function GET() {
  try {
    const prompts = listAllPromptTemplates();
    return NextResponse.json({ prompts });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to load prompt templates.",
      },
      { status: 500 }
    );
  }
}
