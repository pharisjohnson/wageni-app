"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button";

/** Kiosk-safe error screen: no technical detail, large targets, a way back to the welcome screen. */
export default function KioskError({ retry }: { error: Error; retry: () => void }) {
  const { organizationSlug } = useParams<{ organizationSlug: string }>();
  return (
    <main role="alert" className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-xl space-y-6 rounded-2xl border bg-background p-8 text-center">
        <h1 className="text-2xl font-semibold">Something went wrong</h1>
        <p className="text-muted-foreground">Please try again, or ask at reception for help.</p>
        <div className="flex flex-wrap justify-center gap-3">
          <Button size="lg" className="min-h-12 px-6 text-base" onClick={() => retry()}>
            Try again
          </Button>
          <Link
            href={`/kiosk/${organizationSlug}`}
            className={buttonVariants({ size: "lg", variant: "outline", className: "min-h-12 px-6 text-base" })}
          >
            Start over
          </Link>
        </div>
      </div>
    </main>
  );
}
