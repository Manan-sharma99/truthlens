import type { Citation, ConfidenceLevel, Verdict } from "./types";

export interface ConfidenceInput {
  verdict: Verdict;
  citations: Citation[];
  verificationAgreement: "agreed" | "disagreed_reconciled" | "single_pass";
  evidenceSupportsVerdict?: boolean;
}

/**
 * Computes qualitative verdict confidence and factual truth confidence separately:
 * - Verdict Confidence: how well-supported the assigned verdict is by evidence sufficiency,
 *   verbatim citation validity, and independent verification agreement.
 *   IMPORTANT: Independent agreement alone CANNOT justify High confidence when evidence
 *   is ambiguous or insufficient (capped at Medium).
 * - Factual Truth Confidence: bounded by the fact that user-supplied reference sources
 *   have unverified external credibility.
 */
export function computeQualitativeConfidence(input: ConfidenceInput): {
  confidence: ConfidenceLevel;
  reason: string;
  factualTruthConfidence: ConfidenceLevel;
  factualTruthNote: string;
} {
  const { verdict, citations, verificationAgreement, evidenceSupportsVerdict } =
    input;

  const totalCitations = citations.length;
  const verifiedCitations = citations.filter((c) => c.verified).length;
  const allCitationsValid =
    totalCitations > 0 && verifiedCitations === totalCitations;
  const hasAnyValidCitation = verifiedCitations > 0;

  if (evidenceSupportsVerdict === false) {
    return {
      confidence: "Low",
      reason:
        "Low: Disagreement reviewer flagged weak alignment between cited evidence and verdict.",
      factualTruthConfidence: "Low",
      factualTruthNote:
        "Low: Evidence-verdict misalignment detected; factual truth cannot be established.",
    };
  }

  if (verdict === "Insufficient Evidence") {
    const confidence: ConfidenceLevel =
      verificationAgreement === "agreed" ? "Medium" : "Low";
    const reason =
      verificationAgreement === "agreed"
        ? "Medium: Independent verifiers agreed that supplied sources are insufficient or ambiguous (capped below High because evidence is insufficient)."
        : verificationAgreement === "disagreed_reconciled"
          ? "Low: Verifiers initially disagreed; adjudicated as Insufficient Evidence."
          : "Low: Single-pass assessment found insufficient or ambiguous evidence.";
    return {
      confidence,
      reason,
      factualTruthConfidence: "Low",
      factualTruthNote:
        "Low: Supplied reference material does not establish the factual truth of the claim.",
    };
  }

  // Supported, Contradicted, or Conflicting Evidence require valid citations
  if (totalCitations === 0 || !hasAnyValidCitation) {
    return {
      confidence: "Low",
      reason:
        totalCitations === 0
          ? "Low: No verbatim citations provided to ground the verdict."
          : "Low: Cited quotes could not be verified verbatim in the supplied sources.",
      factualTruthConfidence: "Low",
      factualTruthNote:
        "Low: Without verified citations, factual truth relative to the source is unestablished.",
    };
  }

  if (!allCitationsValid) {
    return {
      confidence: "Low",
      reason: `Low: Only ${verifiedCitations}/${totalCitations} citations passed verbatim source validation.`,
      factualTruthConfidence: "Low",
      factualTruthNote:
        "Low: Partial citation failure reduces confidence in factual grounding.",
    };
  }

  if (verificationAgreement === "agreed") {
    return {
      confidence: "High",
      reason:
        "High: All citations verified verbatim and independent verifiers (Stage 3 & Stage 4) agreed.",
      factualTruthConfidence: "Medium",
      factualTruthNote:
        "Medium: Strongly grounded in the supplied text, but external source credibility is unverified.",
    };
  }

  if (verificationAgreement === "disagreed_reconciled") {
    return {
      confidence: "Medium",
      reason:
        "Medium: Citations verified verbatim, but Stage 3 and Stage 4 disagreed and required adjudication.",
      factualTruthConfidence: "Low",
      factualTruthNote:
        "Low: Verifier disagreement and unverified source credibility limit factual truth certainty.",
    };
  }

  return {
    confidence: "Medium",
    reason:
      "Medium: Citations verified verbatim, but evaluated in a single pass without independent verification.",
    factualTruthConfidence: "Low",
    factualTruthNote:
      "Low: Single-pass check with unverified source credibility.",
  };
}
