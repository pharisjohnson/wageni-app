"use client";

import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { errorCode, errorMessage } from "@/lib/auth/errors";

export default function AppError({ error, retry }: { error: Error; retry: () => void }) {
  const code = errorCode(error);
  const message =
    code === "FORBIDDEN"
      ? "You do not have permission to view this."
      : code === "NOT_FOUND"
        ? "This record does not exist or you no longer have access to it."
        : errorMessage(error);
  return (
    <div role="alert" className="space-y-4 rounded-xl border p-6">
      <h2 className="text-lg font-semibold">Unable to load this page</h2>
      <p className="text-sm text-muted-foreground">{message}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => retry()}>
          Try again
        </Button>
        <Link href="/app" className={buttonVariants({ variant: "ghost" })}>
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
