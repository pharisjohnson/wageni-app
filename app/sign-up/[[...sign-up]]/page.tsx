import { SignUp } from "@clerk/nextjs";
import Link from "next/link";
import { Suspense } from "react";
import { FullPageSpinner } from "@/components/layout/full-page-spinner";
import { SetupRequired } from "@/components/layout/setup-required";
import { isBackendConfigured } from "@/lib/config";

export const metadata = { title: "Create an account" };

export default function SignUpPage() {
  if (!isBackendConfigured) return <SetupRequired />;
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-12">
      {/* Reads the catch-all route on the client, so it streams in. */}
      <Suspense fallback={<FullPageSpinner />}>
        <SignUp signInUrl="/sign-in" fallbackRedirectUrl="/onboarding" />
      </Suspense>
      <Link href="/" className="inline-flex min-h-10 items-center text-sm text-muted-foreground hover:text-foreground">
        ← Back to home
      </Link>
    </main>
  );
}
