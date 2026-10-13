"use client";

import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";

export default function RootError({ retry }: { error: Error; retry: () => void }) {
  return (
    <main role="alert" className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-4 px-4 py-24">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground">We could not load this page. You can try again or go back home.</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => retry()}>Try again</Button>
        <Link href="/" className={buttonVariants({ variant: "outline" })}>
          Back to home
        </Link>
      </div>
    </main>
  );
}
