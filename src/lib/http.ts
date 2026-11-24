export class ApiRequestError extends Error {
  status: number;
  code?: string;
  retryAfterSec?: number;

  constructor(
    message: string,
    status: number,
    code?: string,
    retryAfterSec?: number
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

function mapNonJsonPlatformError(status: number, rawText: string): string {
  const lower = rawText.toLowerCase();
  if (
    status === 504 ||
    lower.includes("function_invocation_timeout") ||
    lower.includes("gateway timeout")
  ) {
    return "The server timed out (HTTP 504) while waiting for the verification model. Try running the verification again or waiting briefly if Gemini rate limits are active.";
  }
  if (status === 503 || lower.includes("unavailable")) {
    return "The service is temporarily unavailable (HTTP 503). Please retry shortly.";
  }
  if (status === 429) {
    return "API rate limit exceeded (HTTP 429). Please wait briefly before retrying.";
  }
  if (status === 502) {
    return "Upstream model gateway error (HTTP 502). Please retry.";
  }
  const snippet = rawText.trim().slice(0, 140);
  return snippet
    ? `Server returned non-JSON response (HTTP ${status}): ${snippet}`
    : `Server returned non-JSON response (HTTP ${status}).`;
}

/**
 * Safely parses API responses by inspecting Content-Type and response text first,
 * preventing crashes like `Unexpected token 'A', "An error o"... is not valid JSON`
 * when a hosting platform returns HTML or plain-text error pages.
 */
export async function readApiJson<T>(res: Response): Promise<T> {
  const rawText = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  const looksLikeJson =
    contentType.toLowerCase().includes("application/json") ||
    rawText.trim().startsWith("{") ||
    rawText.trim().startsWith("[");

  let parsed: unknown = null;
  if (looksLikeJson && rawText.trim().length > 0) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const p = parsed as {
        error?: string;
        code?: string;
        retryAfterSec?: number;
      };
      const retryHeader = res.headers.get("retry-after");
      const retryAfterSec =
        p.retryAfterSec ??
        (retryHeader ? Number.parseInt(retryHeader, 10) || undefined : undefined);
      throw new ApiRequestError(
        p.error || `Request failed with HTTP ${res.status}.`,
        res.status,
        p.code,
        retryAfterSec
      );
    }
    throw new ApiRequestError(
      mapNonJsonPlatformError(res.status, rawText),
      res.status
    );
  }

  if (parsed === null) {
    throw new ApiRequestError(
      "Server returned an invalid or non-JSON response.",
      res.status
    );
  }

  return parsed as T;
}
