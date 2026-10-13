import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SetupRequired } from "@/components/layout/setup-required";
import { isBackendConfigured } from "@/lib/config";

// The link is a credential: keep it out of search engines and referrer headers.
export const metadata: Metadata = {
  title: "Your visit",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function InviteLayout({ children }: { children: ReactNode }) {
  if (!isBackendConfigured) return <SetupRequired />;
  return <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-8">{children}</main>;
}
