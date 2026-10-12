import { SignIn } from "@clerk/nextjs";
import { Suspense } from "react";
import { FullPageSpinner } from "@/components/layout/full-page-spinner";
import { SetupRequired } from "@/components/layout/setup-required";
import { isBackendConfigured } from "@/lib/config";

export const metadata = { title: "Sign in" };

export default function SignInPage() {
  if (!isBackendConfigured) return <SetupRequired />;
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      {/* Reads the catch-all route on the client, so it streams in. */}
      <Suspense fallback={<FullPageSpinner />}>
        <SignIn signUpUrl="/sign-up" fallbackRedirectUrl="/app" />
      </Suspense>
    </main>
  );
}
