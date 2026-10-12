import Link from "next/link";
import { Settings2 } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

/** Shown in signed-in areas when Convex/Clerk environment variables are missing. */
export function SetupRequired() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-4 px-4 py-16">
      <Settings2 className="size-8 text-muted-foreground" aria-hidden />
      <h1 className="text-2xl font-semibold">Backend not configured</h1>
      <p className="text-muted-foreground">
        Sign-in and organization features need a Convex deployment and Clerk keys. Set{" "}
        <code className="rounded bg-muted px-1">NEXT_PUBLIC_CONVEX_URL</code>,{" "}
        <code className="rounded bg-muted px-1">NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code> and{" "}
        <code className="rounded bg-muted px-1">CLERK_SECRET_KEY</code> in{" "}
        <code className="rounded bg-muted px-1">.env.local</code>, then restart the dev server. See{" "}
        <code className="rounded bg-muted px-1">docs/setup.md</code>.
      </p>
      <Link href="/" className={buttonVariants({ variant: "outline", className: "self-start" })}>
        Back to home
      </Link>
    </main>
  );
}
