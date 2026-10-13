import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AuthGate } from "@/components/layout/auth-gate";
import { SetupRequired } from "@/components/layout/setup-required";
import { isBackendConfigured } from "@/lib/config";
import { OnboardingForm } from "./onboarding-form";

export const metadata = { title: "Create your organization" };

export default function OnboardingPage() {
  if (!isBackendConfigured) return <SetupRequired />;
  return (
    <AuthGate>
      <main className="mx-auto w-full max-w-lg flex-1 space-y-4 px-4 py-12">
        <Link
          href="/"
          className="inline-flex min-h-10 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden /> Back to home
        </Link>
        <OnboardingForm />
      </main>
    </AuthGate>
  );
}
