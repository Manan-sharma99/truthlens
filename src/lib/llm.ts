import { GoogleGenAI } from "@google/genai";
import { isReadOnlyProduction } from "./runtime.ts";

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "GEMINI_API_KEY is not configured. Add GEMINI_API_KEY to your environment variables and restart."
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
  retryAfterSec?: number;
  constructor(message: string, retryAfterSec?: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSec = retryAfterSec;
  }
}

export class ServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}

export class ExecutionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionTimeoutError";
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
      return Math.min(Math.ceil(sec * 1000) + 1000, 65000);
    }
  }
  return 16000;
}

function isTransientApiError(err: unknown): {
  transient: boolean;
  isRateLimit: boolean;
  isUnavailable: boolean;
} {
  const msg = err instanceof Error ? err.message : String(err);
  const isRateLimit = msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED");
  const isUnavailable = msg.includes("503") || msg.includes("UNAVAILABLE");
  return {
    transient: isRateLimit || isUnavailable,
    isRateLimit,
    isUnavailable,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withDeadline<T>(promise: Promise<T>, remainingMs: number): Promise<T> {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return Promise.reject(
      new ExecutionTimeoutError(
        "Verification exceeded server execution time budget before model responded."
      )
    );
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new ExecutionTimeoutError(
          "Model call exceeded server execution time budget before completion."
        )
      );
    }, remainingMs);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export interface LlmJsonResponse<T> {
  data: T;
  rawText: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CallStructuredJsonOptions {
  /** Absolute epoch ms deadline so server returns structured JSON before Vercel kills the function */
  deadlineMs?: number;
  maxRetries?: number;
}

export async function callStructuredJson<T>(
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  options?: CallStructuredJsonOptions
): Promise<LlmJsonResponse<T>> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new MissingApiKeyError();
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = getModelName();
  const readOnlyProd = isReadOnlyProduction();
  const maxRetries =
    options?.maxRetries ?? (readOnlyProd ? 1 : 4);
  const deadlineMs =
    options?.deadlineMs ?? (readOnlyProd ? Date.now() + 48_000 : undefined);

  let response;
  let latencyMs = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const start = Date.now();
    try {
      const callPromise = ai.models.generateContent({
        model,
        contents: userPrompt,
        config: {
          systemInstruction: systemPrompt,
          temperature,
          responseMimeType: "application/json",
        },
      });
      response =
        deadlineMs !== undefined
          ? await withDeadline(callPromise, deadlineMs - Date.now())
          : await callPromise;
      latencyMs = Date.now() - start;
      break;
    } catch (err) {
      if (err instanceof ExecutionTimeoutError) {
        throw err;
      }
      const { transient, isRateLimit, isUnavailable } =
        isTransientApiError(err);
      if (transient) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const rawWaitMs = isRateLimit ? parseRetryDelayMs(errMsg) : 4000;
        const retrySec = Math.ceil(rawWaitMs / 1000);
        const remainingMs =
          deadlineMs !== undefined ? deadlineMs - Date.now() : Infinity;

        // In serverless production, fail fast with structured JSON rather than sleeping into a platform 504 timeout
        const canRetryWithinBudget =
          attempt < maxRetries &&
          remainingMs > rawWaitMs + 10_000 &&
          (!readOnlyProd || rawWaitMs <= 18_000);

        if (!canRetryWithinBudget) {
          if (isRateLimit) {
            throw new RateLimitError(
              `Gemini API rate limit (429 RESOURCE_EXHAUSTED) reached. Please retry in ~${retrySec}s.`,
              retrySec
            );
          }
          if (isUnavailable) {
            throw new ServiceUnavailableError(
              "Gemini API is temporarily experiencing high demand (503 UNAVAILABLE). Please retry shortly."
            );
          }
          throw err;
        }
        await sleep(rawWaitMs);
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
