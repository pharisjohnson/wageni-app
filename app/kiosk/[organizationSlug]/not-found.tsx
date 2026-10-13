"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";

export default function KioskNotFound() {
  const { organizationSlug } = useParams<{ organizationSlug: string }>();
  return (
    <div className="w-full max-w-xl space-y-6 rounded-2xl border bg-background p-8 text-center">
      <h1 className="text-2xl font-semibold">Screen not found</h1>
      <p className="text-muted-foreground">Please go back to the welcome screen.</p>
      <Link
        href={`/kiosk/${organizationSlug}`}
        className={buttonVariants({ size: "lg", className: "min-h-12 px-6 text-base" })}
      >
        Start over
      </Link>
    </div>
  );
}
