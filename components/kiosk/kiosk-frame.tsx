"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, type CSSProperties, type ReactNode } from "react";
import { FullPageSpinner } from "@/components/layout/full-page-spinner";
import { api } from "@/convex/_generated/api";

type KioskOrg = NonNullable<FunctionReturnType<typeof api.organizations.getPublicBySlug>>;

const KioskContext = createContext<KioskOrg | null>(null);

export function useKioskOrg() {
  const org = useContext(KioskContext);
  if (!org) throw new Error("useKioskOrg must be used inside KioskFrame");
  return org;
}

/** Seconds of inactivity before a kiosk sub-screen resets to the welcome screen. */
const IDLE_SECONDS = 90;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart", "scroll"] as const;

/**
 * Returns to the welcome screen after inactivity. Navigating away unmounts
 * the sub-screen, which discards any partly entered personal data (kept in
 * React state only — never written to browser storage).
 */
function useInactivityReset(home: string) {
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (pathname === home) return;
    let timer = window.setTimeout(() => router.replace(home), IDLE_SECONDS * 1000);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => router.replace(home), IDLE_SECONDS * 1000);
    };
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [home, pathname, router]);
}

/** Black or white text, whichever contrasts better with a #rrggbb background. */
function readableForeground(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.179 ? "#000000" : "#ffffff";
}

export function KioskFrame({ slug, children }: { slug: string; children: ReactNode }) {
  const org = useQuery(api.organizations.getPublicBySlug, { slug });
  useInactivityReset(`/kiosk/${slug}`);

  if (org === undefined) return <FullPageSpinner />;
  if (org === null) {
    return (
      <main className="flex flex-1 items-center justify-center p-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">Kiosk not available</h1>
          <p className="text-muted-foreground">This organization address does not exist or is not active.</p>
        </div>
      </main>
    );
  }

  const color = org.branding.primaryColor;
  const style = color
    ? ({ "--primary": color, "--primary-foreground": readableForeground(color) } as CSSProperties)
    : undefined;

  return (
    <KioskContext.Provider value={org}>
      <div style={style} className="flex min-h-svh flex-1 flex-col bg-muted/40">
        <header className="flex items-center gap-3 border-b bg-background px-6 py-4">
          {org.branding.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- arbitrary customer-hosted logo URL
            <img src={org.branding.logoUrl} alt="" className="h-10 w-auto max-w-40 object-contain" />
          ) : null}
          <span className="text-lg font-semibold">{org.name}</span>
        </header>
        <main className="flex flex-1 flex-col items-center justify-center p-6">{children}</main>
      </div>
    </KioskContext.Provider>
  );
}
