export function downloadJson(filename: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadText(
  filename: string,
  content: string,
  mimeType = "text/markdown;charset=utf-8;"
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function formatVerificationRunMarkdown(
  run: import("./types").VerificationRun
): string {
  const lines: string[] = [
    `# TruthLens Verification Report (${run.version})`,
    ``,
    `- **Run ID:** \`${run.runId}\``,
    `- **Created At:** ${run.createdAt}`,
    `- **Prompt Version:** ${run.version}`,
    `- **Model:** ${run.modelConfig.model}`,
    `- **Temperatures:** ${Object.entries(run.modelConfig.temperatures)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`,
    `- **Latency:** ${run.metrics.totalLatencyMs} ms`,
    `- **Tokens:** ${run.metrics.totalInputTokens} in / ${run.metrics.totalOutputTokens} out`,
    `- **Verbatim Citations:** ${run.metrics.verifiedCitations} / ${run.metrics.totalCitations}`,
    ``,
    `## Claim / Statement Evaluated`,
    `> ${run.claimInput}`,
    ``,
    `## Executive Summary`,
    run.summary,
  ];

  if (run.methodologyNote) {
    lines.push(``, `**Methodology Note:** ${run.methodologyNote}`);
  }

  lines.push(``, `## Verified Claims`);
  for (const c of run.claims) {
    lines.push(
      ``,
      `### ${c.claimId}: ${c.claimText}`,
      `- **Verdict:** ${c.verdict}`,
      `- **Verdict Confidence:** ${c.confidence} (${c.confidenceReason})`,
      `- **Factual Truth Confidence:** ${c.factualTruthConfidence} (${c.factualTruthNote})`,
      `- **Source Credibility:** ${c.sourceCredibilityStatus}`,
      `- **Explanation:** ${c.explanation}`
    );
    if (c.missingInformation) {
      lines.push(`- **Missing Information:** ${c.missingInformation}`);
    }
    if (c.requiredEvidence) {
      lines.push(`- **Required Evidence:** ${c.requiredEvidence}`);
    }
    if (c.citations.length > 0) {
      lines.push(`- **Citations:**`);
      for (const cit of c.citations) {
        lines.push(
          `  - [${cit.sourceId} — ${cit.sourceTitle}] (${cit.verified ? "Verbatim Verified" : "Unverified"}): "${cit.quote}"`
        );
      }
    }
  }

  lines.push(``, `## Intermediate Stage Traces (${run.stages.length})`);
  for (const s of run.stages) {
    lines.push(
      ``,
      `### ${s.stageName} (\`${s.stageId}\`, temp=${s.temperature}, ${s.latencyMs}ms, ${s.inputTokens}+${s.outputTokens} tok)`,
      `\`\`\`json`,
      s.rawOutput,
      `\`\`\``
    );
  }

  return lines.join("\n");
}
