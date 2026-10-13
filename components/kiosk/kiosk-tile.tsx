import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const tile =
  "flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl p-8 text-center text-xl font-semibold shadow-sm outline-none transition-transform focus-visible:ring-4 focus-visible:ring-ring/50 active:scale-[0.98]";

/** Large touch target that leads to the next kiosk step. */
export function KioskTile({
  href,
  icon: Icon,
  label,
  hint,
  primary,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  hint?: string;
  primary?: boolean;
}) {
  return (
    <Link href={href} className={cn(tile, primary ? "bg-primary text-primary-foreground" : "border bg-background")}>
      <Icon className="size-10" aria-hidden />
      {label}
      {hint && <span className="text-sm font-normal opacity-80">{hint}</span>}
    </Link>
  );
}
