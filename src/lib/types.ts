export type PromptVersion = "V1" | "V2" | "V3";

export type Verdict =
  | "Supported"
  | "Contradicted"
  | "Insufficient Evidence"
  | "Conflicting Evidence";

export type ConfidenceLevel = "High" | "Medium" | "Low";

export type EvalMode = "atomic" | "end_to_end";

export type EvalSplit = "development" | "held_out";

export type LabelStatus = "provisional" | "reviewed";

export interface ReferenceSource {
  id: string;
  title: string;
  type: "text" | "txt" | "pdf";
  content: string;
  charCount: number;
}

export interface Citation {
  sourceId: string;
  sourceTitle: string;
  quote: string;
  verified: boolean;
  validationNote: string;
}

export interface VerifiedClaim {
  claimId: string;
  claimText: string;
  verdict: Verdict;
  /** Confidence in the assigned verdict based on evidence sufficiency, citation validity, and verifier agreement */
  confidence: ConfidenceLevel;
  confidenceReason: string;
  /** Distinct from verdict confidence: reflects whether factual truth in the real world is established (always bounded by unverified user-source credibility) */
  factualTruthConfidence: ConfidenceLevel;
  factualTruthNote: string;
  sourceCredibilityStatus: "Unverified User-Supplied Source";
  explanation: string;
  citations: Citation[];
  verificationAgreement?: "agreed" | "disagreed_reconciled" | "single_pass";
  stage3Verdict?: Verdict;
  stage4Verdict?: Verdict;
  evidenceAlignment?: {
    assessed: boolean;
    supportsVerdict: boolean;
    note: string;
  };
  /** For Insufficient Evidence: explains what specific information is missing */
  missingInformation?: string;
  /** For Insufficient Evidence: describes what evidence would be needed to reach a verdict */
  requiredEvidence?: string;
}

export interface PromptTemplate {
  id: string;
  version: PromptVersion;
  stage: string;
  stageNumber?: number;
  name: string;
  description: string;
  temperature: number;
  systemPrompt: string;
  userTemplate: string;
}

export interface StageTrace {
  stageId: string;
  stageName: string;
  templateId: string;
  temperature: number;
  systemPrompt: string;
  renderedUserPrompt: string;
  rawOutput: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface InjectionScanResult {
  flagged: boolean;
  warnings: string[];
}

export interface VerificationRun {
  runId: string;
  createdAt: string;
  version: PromptVersion;
  modelConfig: {
    model: string;
    temperatures: Record<string, number>;
  };
  claimInput: string;
  sources: Array<{
    id: string;
    title: string;
    type: ReferenceSource["type"];
    charCount: number;
  }>;
  injectionScan: InjectionScanResult;
  summary: string;
  methodologyNote?: string;
  claims: VerifiedClaim[];
  stages: StageTrace[];
  metrics: {
    totalLatencyMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCitations: number;
    verifiedCitations: number;
    citationValidityRate: number;
    disagreementCount: number;
  };
}

export interface EvalCase {
  id: string;
  title: string;
  evalMode: EvalMode;
  split: EvalSplit;
  labelStatus: LabelStatus;
  category: string;
  claimInput: string;
  sources: ReferenceSource[];
  expectedClaims: Array<{
    keyPhrase: string;
    expectedVerdict: Verdict;
  }>;
  notes: string;
}

export interface FailureRecord {
  caseId: string;
  caseTitle: string;
  evalMode: EvalMode;
  split: EvalSplit;
  version: PromptVersion;
  failureType:
    | "Verdict Mismatch"
    | "Unverified Citation"
    | "Evidence-Verdict Misalignment"
    | "Overconfident Unsupported"
    | "Missed Claim"
    | "Duplicate Claim"
    | "Unexpected Claim";
  expected: string;
  actual: string;
  details: string;
}

export interface EvalModeSummary {
  totalCases: number;
  verdictAccuracy: number;
  citationValidityRate: number;
  overconfidenceRate: number;
}

export interface EvalCaseResult {
  caseId: string;
  caseTitle: string;
  category: string;
  evalMode: EvalMode;
  split: EvalSplit;
  labelStatus: LabelStatus;
  claimInput: string;
  referenceSummary: string;
  expectedOutput: string;
  actualOutput: string;
  passed: boolean;
  matchedClaims: number;
  expectedClaimsCount: number;
  extractedClaimsCount?: number;
  duplicateOrUnexpectedClaims?: number;
  citationValidityRate: number;
  confidenceSummary: string;
  observedIssue: string;
  latencyMs: number;
  tokens: number;
  runId: string;
  summary: string;
}

export interface EvalRunResult {
  evalId: string;
  createdAt: string;
  version: PromptVersion;
  model: string;
  splitFilter: EvalSplit | "all";
  partial?: boolean;
  totalCases: number;
  verdictAccuracy: number;
  citationValidityRate: number;
  overconfidenceRate: number;
  avgLatencyMs: number;
  totalTokens: number;
  byMode: {
    atomic: EvalModeSummary;
    end_to_end: EvalModeSummary;
  };
  caseResults: EvalCaseResult[];
  failures: FailureRecord[];
}

export interface PromptIterationEntry {
  iterationId: string;
  timestamp: string;
  savedPromptVersion: string;
  targetFiles: string[];
  changesIntroduced: string;
  reasonForModification: string;
  observedFailure: string;
  representativeModelOutputs: string;
  retestResults: string;
  modelConfig: string;
  executionTimeMs: number;
  tokenUsage: number;
}

export interface AppValidationResult {
  testId: string;
  category: string;
  inputSummary: string;
  expectedBehavior: string;
  actualBehavior: string;
  passed: boolean;
  observedIssue: string;
  executedAt: string;
}
