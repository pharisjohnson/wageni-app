"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import type { ReactNode } from "react";
import { FullPageSpinner } from "@/components/layout/full-page-spinner";
import { UserMenu } from "@/components/layout/user-menu";
import { api } from "@/convex/_generated/api";
import { appConfig } from "@/lib/config";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/platform", label: "Overview" },
  { href: "/platform/organizations", label: "Organizations" },
  { href: "/platform/usage", label: "Usage" },
];

/**
 * UX gate for the operator console. The Convex platform functions check the
 * platform role themselves; this only avoids rendering a page that would fail.
 */
export function PlatformShell({ children }: { children: ReactNode }) {
  const me = useQuery(api.users.me);
  const pathname = usePathname();
  if (me === undefined) return <FullPageSpinner />;
  if (!me?.isPlatformAdmin) {
    return (
      <main className="flex flex-1 items-center justify-center p-6">
        <p className="text-muted-foreground">This area is restricted to platform operators.</p>
      </main>
    );
  }
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link href="/platform" className="font-semibold">
            {appConfig.name} · Platform
          </Link>
          <nav aria-label="Platform" className="flex gap-1 overflow-x-auto">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                  pathname === item.href && "bg-muted text-foreground",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto">
            <UserMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 p-4 sm:p-6">{children}</main>
    </div>
  );
}
