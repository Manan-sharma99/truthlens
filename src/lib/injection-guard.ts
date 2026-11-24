import type { InjectionScanResult, ReferenceSource } from "./types";

const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
    label: "Instruction override attempt ('ignore previous instructions')",
  },
  {
    pattern: /disregard\s+(all\s+)?(system|previous|prior)\s+(prompt|instructions?)/i,
    label: "System prompt override attempt ('disregard system prompt')",
  },
  {
    pattern: /you\s+are\s+now\s+(a|an|in)\s+/i,
    label: "Role hijacking attempt ('you are now ...')",
  },
  {
    pattern: /<\/?(untrusted_claim|reference_source|reference_sources|system)>/i,
    label: "Delimiter breakout tag detected",
  },
  {
    pattern: /always\s+(return|classify|mark)\s+(this|all|every)\s+.*(supported|true)/i,
    label: "Forced verdict manipulation attempt",
  },
  {
    pattern: /reveal\s+(your\s+)?(system\s+prompt|api\s*key|instructions)/i,
    label: "Prompt/secret exfiltration attempt",
  },
];

/**
 * Scans untrusted user claims and reference material for common prompt-injection
 * patterns so the UI can surface warnings and audit trails.
 */
export function scanForPromptInjection(texts: string[]): InjectionScanResult {
  const warnings = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const { pattern, label } of INJECTION_PATTERNS) {
      if (pattern.test(text)) {
        warnings.add(label);
      }
    }
  }
  return {
    flagged: warnings.size > 0,
    warnings: Array.from(warnings),
  };
}

/**
 * Neutralizes XML-like boundary tags inside untrusted content so inputs cannot
 * close the isolation container early.
 */
export function sanitizeDelimiterTags(text: string): string {
  return text.replace(
    /<(\/?)(untrusted_claim|reference_source|reference_sources|system)>/gi,
    "[$1$2]"
  );
}

/**
 * Formats reference sources inside explicit XML boundary tags for grounded prompting.
 */
export function formatSourcesBlock(sources: ReferenceSource[]): string {
  return sources
    .map((src) => {
      const safeTitle = sanitizeDelimiterTags(src.title).replace(/"/g, "'");
      const safeContent = sanitizeDelimiterTags(src.content);
      return `<reference_source id="${src.id}" title="${safeTitle}">\n${safeContent}\n</reference_source>`;
    })
    .join("\n\n");
}
