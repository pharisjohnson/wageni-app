import { AuthGate } from "@/components/layout/auth-gate";
import { SetupRequired } from "@/components/layout/setup-required";
import { PlatformShell } from "@/components/platform/platform-shell";
import { isBackendConfigured } from "@/lib/config";

export default function PlatformLayout({ children }: LayoutProps<"/platform">) {
  if (!isBackendConfigured) return <SetupRequired />;
  return (
    <AuthGate>
      <PlatformShell>{children}</PlatformShell>
    </AuthGate>
  );
}
