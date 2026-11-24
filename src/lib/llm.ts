import { GoogleGenAI } from "@google/genai";

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "GEMINI_API_KEY is not configured. Add GEMINI_API_KEY to .env.local and restart the server."
    );
    this.name = "MissingApiKeyError";
  }
}

export class LlmParseError extends Error {
  rawText: string;
  constructor(message: string, rawText: string) {
    super(message);
    this.name = "LlmParseError";
    this.rawText = rawText;
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export function getModelName(): string {
  return process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
}

export function isApiConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY?.trim();
  return Boolean(key && key.length > 0);
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
  }
  return trimmed;
}

function parseRetryDelayMs(errMsg: string): number {
  const match = errMsg.match(/retry in\s+([\d.]+)s/i);
  if (match) {
    const sec = Number.parseFloat(match[1]);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.min(Math.ceil(sec * 1000) + 1500, 65000);
    }
  }
  return 16000;
}

function isTransientApiError(err: unknown): { transient: boolean; isRateLimit: boolean } {
  const msg = err instanceof Error ? err.message : String(err);
  const isRateLimit = msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED");
  const isUnavailable = msg.includes("503") || msg.includes("UNAVAILABLE");
  return { transient: isRateLimit || isUnavailable, isRateLimit };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LlmJsonResponse<T> {
  data: T;
  rawText: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export async function callStructuredJson<T>(
  systemPrompt: string,
  userPrompt: string,
  temperature: number
): Promise<LlmJsonResponse<T>> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new MissingApiKeyError();
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = getModelName();
  const maxRetries = 4;

  let response;
  let latencyMs = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const start = Date.now();
    try {
      response = await ai.models.generateContent({
        model,
        contents: userPrompt,
        config: {
          systemInstruction: systemPrompt,
          temperature,
          responseMimeType: "application/json",
        },
      });
      latencyMs = Date.now() - start;
      break;
    } catch (err) {
      const { transient, isRateLimit } = isTransientApiError(err);
      if (transient) {
        if (attempt === maxRetries) {
          if (isRateLimit) {
            throw new RateLimitError(
              "Gemini API rate limit (429 RESOURCE_EXHAUSTED) exceeded after retries."
            );
          }
          throw err;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        const waitMs = isRateLimit ? parseRetryDelayMs(errMsg) : 6000;
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }

  const rawText = response?.text ?? "";
  const inputTokens = response?.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = response?.usageMetadata?.candidatesTokenCount ?? 0;

  const cleaned = stripJsonFences(rawText);
  try {
    const data = JSON.parse(cleaned) as T;
    return { data, rawText, latencyMs, inputTokens, outputTokens };
  } catch (err) {
    throw new LlmParseError(
      `Model returned invalid JSON: ${err instanceof Error ? err.message : "Parse error"}`,
      rawText
    );
  }
}
