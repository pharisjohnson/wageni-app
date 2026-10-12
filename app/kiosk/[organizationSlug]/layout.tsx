import { Suspense } from "react";
import { KioskFrame } from "@/components/kiosk/kiosk-frame";
import { FullPageSpinner } from "@/components/layout/full-page-spinner";
import { SetupRequired } from "@/components/layout/setup-required";
import { isBackendConfigured } from "@/lib/config";

export const metadata = { title: "Kiosk", robots: { index: false, follow: false } };

async function KioskForSlug({ params, children }: LayoutProps<"/kiosk/[organizationSlug]">) {
  const { organizationSlug } = await params;
  return <KioskFrame slug={organizationSlug}>{children}</KioskFrame>;
}

export default function KioskLayout(props: LayoutProps<"/kiosk/[organizationSlug]">) {
  if (!isBackendConfigured) return <SetupRequired />;
  // The slug is request data, so it is read inside a Suspense boundary.
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <KioskForSlug {...props} />
    </Suspense>
  );
}
