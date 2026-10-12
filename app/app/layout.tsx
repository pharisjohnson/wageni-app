import { AppShell } from "@/components/layout/app-shell";
import { AuthGate } from "@/components/layout/auth-gate";
import { SetupRequired } from "@/components/layout/setup-required";
import { isBackendConfigured } from "@/lib/config";
import { ActiveOrgProvider } from "@/lib/org/active-org";

export default function AppLayout({ children }: LayoutProps<"/app">) {
  if (!isBackendConfigured) return <SetupRequired />;
  return (
    <AuthGate>
      <ActiveOrgProvider>
        <AppShell>{children}</AppShell>
      </ActiveOrgProvider>
    </AuthGate>
  );
}
