import { NextResponse } from "next/server";
import { POST as parseSourcePost } from "@/app/api/parse-source/route";
import { POST as verifyPost } from "@/app/api/verify/route";
import { isReadOnlyProduction } from "@/lib/runtime";
import { saveAppValidationResults } from "@/lib/storage";
import type { AppValidationResult } from "@/lib/types";

/**
 * Runs deterministic application-level input validation tests (empty claim,
 * empty reference material, corrupted/unsupported files) strictly separated
 * from factual verification benchmark metrics.
 */
export async function POST() {
  const executedAt = new Date().toISOString();
  const results: AppValidationResult[] = [];

  // 1. Empty claim input
  {
    const req = new Request("http://localhost/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "V3",
        claimInput: "   ",
        sources: [
          {
            id: "S1",
            title: "T",
            type: "text",
            content: "Valid reference.",
            charCount: 16,
          },
        ],
      }),
    });
    const res = await verifyPost(req);
    const json = (await res.json()) as { error?: string };
    const passed = res.status === 400 && Boolean(json.error);
    results.push({
      testId: "app-01",
      category: "Empty claim input",
      inputSummary: 'claimInput="   ", valid S1',
      expectedBehavior: "HTTP 400 rejection before LLM call",
      actualBehavior: `HTTP ${res.status}: ${json.error ?? "ok"}`,
      passed,
      observedIssue: passed ? "None" : "Did not reject empty claim with 400",
      executedAt,
    });
  }

  // 2. Empty reference material
  {
    const req = new Request("http://localhost/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "V3",
        claimInput: "SolarGrid installed 350 MW in 2025.",
        sources: [{ id: "S1", title: "Empty", type: "text", content: "  ", charCount: 2 }],
      }),
    });
    const res = await verifyPost(req);
    const json = (await res.json()) as { error?: string };
    const passed = res.status === 400 && Boolean(json.error);
    results.push({
      testId: "app-02",
      category: "Empty reference material",
      inputSummary: 'valid claim, sources=[{content:"  "}]',
      expectedBehavior: "HTTP 400 rejection before LLM call",
      actualBehavior: `HTTP ${res.status}: ${json.error ?? "ok"}`,
      passed,
      observedIssue: passed
        ? "None"
        : "Did not reject empty reference source with 400",
      executedAt,
    });
  }

  // 3. Corrupted PDF file
  {
    const fd = new FormData();
    fd.append(
      "file",
      new File([Buffer.from("%PDF-1.4\ncorrupt-bytes")], "corrupt.pdf", {
        type: "application/pdf",
      })
    );
    const req = new Request("http://localhost/api/parse-source", {
      method: "POST",
      body: fd,
    });
    const res = await parseSourcePost(req);
    const json = (await res.json()) as { error?: string };
    const passed = res.status >= 400 && Boolean(json.error);
    results.push({
      testId: "app-03a",
      category: "Invalid or corrupted files (Corrupt PDF)",
      inputSummary: "corrupt.pdf (malformed PDF bytes)",
      expectedBehavior: "HTTP 4xx/5xx error without crash",
      actualBehavior: `HTTP ${res.status}: ${json.error ?? "ok"}`,
      passed,
      observedIssue: passed ? "None" : "Corrupt PDF was not rejected",
      executedAt,
    });
  }

  // 4. Empty TXT file
  {
    const fd = new FormData();
    fd.append(
      "file",
      new File([Buffer.from("   ")], "empty.txt", { type: "text/plain" })
    );
    const req = new Request("http://localhost/api/parse-source", {
      method: "POST",
      body: fd,
    });
    const res = await parseSourcePost(req);
    const json = (await res.json()) as { error?: string };
    const passed = res.status === 400 && Boolean(json.error);
    results.push({
      testId: "app-03b",
      category: "Invalid or corrupted files (Empty TXT)",
      inputSummary: "empty.txt (whitespace only)",
      expectedBehavior: "HTTP 400 rejection",
      actualBehavior: `HTTP ${res.status}: ${json.error ?? "ok"}`,
      passed,
      observedIssue: passed ? "None" : "Empty TXT was not rejected with 400",
      executedAt,
    });
  }

  saveAppValidationResults(results);
  return NextResponse.json({ results, readOnly: isReadOnlyProduction() });
}
