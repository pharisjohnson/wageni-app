"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { useKioskOrg } from "./kiosk-frame";

export function KioskPlaceholder({ title, message }: { title: string; message: string }) {
  const org = useKioskOrg();
  return (
    <div className="w-full max-w-xl space-y-6 rounded-2xl border bg-background p-8 text-center">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="text-muted-foreground">{message}</p>
      <Link href={`/kiosk/${org.slug}`} className={buttonVariants({ size: "lg", variant: "outline" })}>
        <ArrowLeft aria-hidden /> Back
      </Link>
    </div>
  );
}
