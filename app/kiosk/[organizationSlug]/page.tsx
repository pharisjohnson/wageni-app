"use client";

import Link from "next/link";
import { BadgeCheck, UserRound } from "lucide-react";
import { useKioskOrg } from "@/components/kiosk/kiosk-frame";
import { cn } from "@/lib/utils";

const tile =
  "flex flex-col items-center justify-center gap-4 rounded-2xl p-10 text-2xl font-semibold shadow-sm outline-none transition-transform focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background active:scale-[0.98] min-h-48 sm:min-h-56";

export default function KioskWelcomePage() {
  const org = useKioskOrg();
  return (
    <div className="w-full max-w-3xl space-y-10 text-center">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          {org.branding.welcomeText ?? `Welcome to ${org.name}`}
        </h1>
        <p className="text-lg text-muted-foreground">Please choose an option to continue.</p>
      </div>
      <div className="grid gap-6 sm:grid-cols-2">
        <Link href={`/kiosk/${org.slug}/visitor`} className={cn(tile, "bg-primary text-primary-foreground")}>
          <UserRound className="size-12" aria-hidden />
          Visitor
          <span className="text-base font-normal opacity-90">Here to see someone</span>
        </Link>
        <Link href={`/kiosk/${org.slug}/staff`} className={cn(tile, "border bg-background")}>
          <BadgeCheck className="size-12" aria-hidden />
          Staff
          <span className="text-base font-normal text-muted-foreground">I work here</span>
        </Link>
      </div>
      {org.branding.privacyNotice && (
        <p className="mx-auto max-w-prose whitespace-pre-line text-sm text-muted-foreground">
          {org.branding.privacyNotice}
        </p>
      )}
    </div>
  );
}
