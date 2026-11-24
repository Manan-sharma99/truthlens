import type { Citation, ReferenceSource } from "./types";

export interface RawCitation {
  sourceId?: string;
  quote?: string;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripEdgePunctuation(text: string): string {
  return text.replace(/^[\s"'`“”‘’.,;:!?-]+|[\s"'`“”‘’.,;:!?-]+$/g, "");
}

/**
 * Deterministically validates every LLM-produced citation against the actual
 * supplied reference sources. Never trusts model-claimed quotes without checking.
 */
export function validateCitations(
  rawCitations: RawCitation[] | undefined,
  sources: ReferenceSource[]
): Citation[] {
  if (!Array.isArray(rawCitations) || rawCitations.length === 0) {
    return [];
  }

  const sourceMap = new Map<string, ReferenceSource>();
  for (const s of sources) {
    sourceMap.set(s.id.trim().toLowerCase(), s);
  }

  return rawCitations
    .filter((c) => c && (c.quote || c.sourceId))
    .map((raw) => {
      const sourceId = (raw.sourceId ?? "").trim();
      const quote = (raw.quote ?? "").trim();
      const source = sourceMap.get(sourceId.toLowerCase());

      if (!source) {
        return {
          sourceId: sourceId || "Unknown",
          sourceTitle: "Unknown Source",
          quote,
          verified: false,
          validationNote: `Source ID "${sourceId || "missing"}" does not match any supplied reference.`,
        };
      }

      if (!quote || quote.length < 4) {
        return {
          sourceId: source.id,
          sourceTitle: source.title,
          quote,
          verified: false,
          validationNote: "Citation quote is empty or too short to verify.",
        };
      }

      const normSource = normalizeWhitespace(source.content);
      const normQuote = normalizeWhitespace(quote);

      // 1. Exact whitespace-normalized substring match
      if (normSource.includes(normQuote)) {
        return {
          sourceId: source.id,
          sourceTitle: source.title,
          quote,
          verified: true,
          validationNote: "Exact verbatim match verified in source.",
        };
      }

      // 2. Case-insensitive / edge-punctuation-trimmed match
      const cleanSource = normSource.toLowerCase();
      const cleanQuote = stripEdgePunctuation(normQuote).toLowerCase();
      if (cleanQuote.length >= 6 && cleanSource.includes(cleanQuote)) {
        return {
          sourceId: source.id,
          sourceTitle: source.title,
          quote,
          verified: true,
          validationNote: "Case-insensitive verbatim match verified in source.",
        };
      }

      // 3. Ellipsis-split check (if model used "..." between two real spans)
      if (normQuote.includes("...")) {
        const parts = normQuote
          .split("...")
          .map((p) => stripEdgePunctuation(p).toLowerCase())
          .filter((p) => p.length >= 8);
        if (parts.length >= 2 && parts.every((p) => cleanSource.includes(p))) {
          return {
            sourceId: source.id,
            sourceTitle: source.title,
            quote,
            verified: true,
            validationNote: "Ellipsis-joined spans verified in source.",
          };
        }
      }

      return {
        sourceId: source.id,
        sourceTitle: source.title,
        quote,
        verified: false,
        validationNote:
          "Quote not found verbatim in the referenced source (possible hallucination or paraphrase).",
      };
    });
}
