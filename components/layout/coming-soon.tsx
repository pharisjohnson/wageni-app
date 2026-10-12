import { Construction } from "lucide-react";
import { PageHeader } from "./page-header";

/**
 * Placeholder for modules scheduled in later phases. Deliberately shows no
 * sample data so nothing can be mistaken for real records.
 */
export function ComingSoon({ title, phase, summary }: { title: string; phase: number; summary: string }) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} />
      <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-6">
        <Construction className="size-6 text-muted-foreground" aria-hidden />
        <p className="font-medium">Not available yet — planned for Phase {phase}.</p>
        <p className="max-w-prose text-sm text-muted-foreground">{summary}</p>
      </div>
    </div>
  );
}
