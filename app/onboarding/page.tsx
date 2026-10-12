import { AuthGate } from "@/components/layout/auth-gate";
import { SetupRequired } from "@/components/layout/setup-required";
import { isBackendConfigured } from "@/lib/config";
import { OnboardingForm } from "./onboarding-form";

export const metadata = { title: "Create your organization" };

export default function OnboardingPage() {
  if (!isBackendConfigured) return <SetupRequired />;
  return (
    <AuthGate>
      <main className="mx-auto w-full max-w-lg flex-1 px-4 py-12">
        <OnboardingForm />
      </main>
    </AuthGate>
  );
}
