"use client";

import Link from "next/link";
import { ArrowLeft, RotateCcw } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { useKioskOrg } from "./kiosk-frame";

const target = "min-h-12 px-6 text-base";

/**
 * Back and Start over for every kiosk sub-screen. Back returns to `backHref`
 * (the previous screen); Start over always returns to the welcome screen.
 * Both are at least 48px tall for touch use.
 */
export function KioskNav({ backHref }: { backHref?: string }) {
  const org = useKioskOrg();
  const home = `/kiosk/${org.slug}`;
  return (
    <nav aria-label="Kiosk" className="flex flex-wrap justify-center gap-3">
      <Link href={backHref ?? home} className={buttonVariants({ size: "lg", variant: "outline", className: target })}>
        <ArrowLeft aria-hidden /> Back
      </Link>
      <Link href={home} className={buttonVariants({ size: "lg", variant: "ghost", className: target })}>
        <RotateCcw aria-hidden /> Start over
      </Link>
    </nav>
  );
}
