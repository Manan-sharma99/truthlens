import { NextResponse } from "next/server";
import {
  ExecutionTimeoutError,
  LlmParseError,
  MissingApiKeyError,
  RateLimitError,
  ServiceUnavailableError,
} from "./llm";
import { checkRateLimit, getClientIp } from "./rate-limit";
import { isReadOnlyProduction } from "./runtime";
import type { ReferenceSource } from "./types";

export const MAX_CLAIM_CHARS = 8000;
export const MAX_SOURCES_COUNT = 6;
export const MAX_TOTAL_SOURCE_CHARS = 40000;

export function enforceVerifyRateLimit(req: Request): NextResponse | null {
  if (!isReadOnlyProduction()) return null;
  const ip = getClientIp(req);
  const limit = checkRateLimit(`verify:${ip}`, 30, 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: `Rate limit exceeded for live verification. Please retry in ${limit.retryAfterSec}s.`,
        code: "RATE_LIMITED",
        retryAfterSec: limit.retryAfterSec,
      },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSec) },
      }
    );
  }
  return null;
}

export function validateAndNormalizeVerifyInputs(
  claimInputRaw: unknown,
  sourcesRaw: unknown
):
  | { ok: true; claimInput: string; sources: ReferenceSource[] }
  | { ok: false; response: NextResponse } {
  const claimInput =
    typeof claimInputRaw === "string" ? claimInputRaw.trim() : "";
  const sources = Array.isArray(sourcesRaw) ? sourcesRaw : [];

  if (!claimInput) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Please enter a claim or statement to verify.", code: "INVALID_INPUT" },
        { status: 400 }
      ),
    };
  }

  if (claimInput.length > MAX_CLAIM_CHARS) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: `Claim input exceeds maximum length of ${MAX_CLAIM_CHARS} characters.`,
          code: "PAYLOAD_TOO_LARGE",
        },
        { status: 400 }
      ),
    };
  }

  const validSources = sources.filter(
    (s): s is Partial<ReferenceSource> & { content: string } =>
      Boolean(s) &&
      typeof (s as { content?: unknown }).content === "string" &&
      (s as { content: string }).content.trim().length > 0
  );

  if (validSources.length === 0) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Please provide at least one non-empty reference source.",
          code: "INVALID_INPUT",
        },
        { status: 400 }
      ),
    };
  }

  if (validSources.length > MAX_SOURCES_COUNT) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: `At most ${MAX_SOURCES_COUNT} reference sources are allowed per request.`,
          code: "PAYLOAD_TOO_LARGE",
        },
        { status: 400 }
      ),
    };
  }

  const totalSourceChars = validSources.reduce(
    (sum, s) => sum + s.content.trim().length,
    0
  );
  if (totalSourceChars > MAX_TOTAL_SOURCE_CHARS) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: `Combined reference text exceeds ${MAX_TOTAL_SOURCE_CHARS} characters.`,
          code: "PAYLOAD_TOO_LARGE",
        },
        { status: 400 }
      ),
    };
  }

  const normalizedSources: ReferenceSource[] = validSources.map((s, idx) => ({
    id: s.id?.trim() || `S${idx + 1}`,
    title: s.title?.trim() || `Source ${idx + 1}`,
    type: s.type || "text",
    content: s.content.trim(),
    charCount: s.content.trim().length,
  }));

  return { ok: true, claimInput, sources: normalizedSources };
}

export function mapVerifyErrorToJsonResponse(
  err: unknown,
  fallbackMessage = "Verification request failed."
): NextResponse {
  if (err instanceof MissingApiKeyError) {
    return NextResponse.json(
      { error: err.message, code: "MISSING_API_KEY" },
      { status: 503 }
    );
  }
  if (err instanceof RateLimitError) {
    return NextResponse.json(
      {
        error: err.message,
        code: "GEMINI_RATE_LIMIT",
        retryAfterSec: err.retryAfterSec,
      },
      {
        status: 429,
        headers: err.retryAfterSec
          ? { "Retry-After": String(err.retryAfterSec) }
          : undefined,
      }
    );
  }
  if (err instanceof ServiceUnavailableError) {
    return NextResponse.json(
      { error: err.message, code: "GEMINI_UNAVAILABLE" },
      { status: 503 }
    );
  }
  if (err instanceof ExecutionTimeoutError) {
    return NextResponse.json(
      { error: err.message, code: "EXECUTION_TIMEOUT" },
      { status: 504 }
    );
  }
  if (err instanceof LlmParseError) {
    return NextResponse.json(
      { error: err.message, code: "LLM_PARSE_ERROR", rawText: err.rawText },
      { status: 502 }
    );
  }
  if (err instanceof SyntaxError) {
    return NextResponse.json(
      { error: "Invalid JSON request body.", code: "INVALID_JSON" },
      { status: 400 }
    );
  }
  return NextResponse.json(
    {
      error: err instanceof Error ? err.message : fallbackMessage,
      code: "INTERNAL_ERROR",
    },
    { status: 500 }
  );
}
