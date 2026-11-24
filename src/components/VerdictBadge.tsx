import type { ConfidenceLevel, Verdict } from "@/lib/types";

const VERDICT_STYLES: Record<Verdict, string> = {
  Supported:
    "bg-emerald-500/12 text-emerald-300 border-emerald-500/35",
  Contradicted:
    "bg-rose-500/12 text-rose-300 border-rose-500/35",
  "Conflicting Evidence":
    "bg-amber-500/12 text-amber-300 border-amber-500/35",
  "Insufficient Evidence":
    "bg-slate-500/15 text-slate-300 border-slate-500/35",
};

const CONFIDENCE_STYLES: Record<ConfidenceLevel, string> = {
  High: "bg-teal-500/12 text-teal-300 border-teal-500/30",
  Medium: "bg-sky-500/12 text-sky-300 border-sky-500/30",
  Low: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium tracking-wide ${VERDICT_STYLES[verdict]}`}
    >
      {verdict}
    </span>
  );
}

export function ConfidenceBadge({
  confidence,
  reason,
}: {
  confidence: ConfidenceLevel;
  reason?: string;
}) {
  return (
    <span
      title={reason}
      className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${CONFIDENCE_STYLES[confidence]}`}
    >
      Confidence: {confidence}
    </span>
  );
}
