"use client";

import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { errorMessage } from "@/lib/auth/errors";

export default function PlatformError({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div role="alert" className="space-y-4 rounded-xl border p-6">
      <h2 className="text-lg font-semibold">Unable to load this page</h2>
      <p className="text-sm text-muted-foreground">{errorMessage(error)}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => retry()}>
          Try again
        </Button>
        <Link href="/platform" className={buttonVariants({ variant: "ghost" })}>
          Platform overview
        </Link>
        <Link href="/" className={buttonVariants({ variant: "ghost" })}>
          Home
        </Link>
      </div>
    </div>
  );
}
