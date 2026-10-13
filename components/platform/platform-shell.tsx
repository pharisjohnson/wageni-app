"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
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
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-muted-foreground">This area is restricted to platform operators.</p>
        <Link href="/app" className={buttonVariants({ variant: "outline" })}>
          Go to the app
        </Link>
      </main>
    );
  }
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
          <Link href="/platform" className="font-semibold">
            {appConfig.name} · Platform
          </Link>
          <div className="ml-auto flex items-center gap-1 sm:order-last sm:ml-0">
            <Link href="/app" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Exit to app
            </Link>
            <UserMenu />
          </div>
          {/* Wraps onto its own row on narrow screens instead of being hidden. */}
          <nav aria-label="Platform" className="-mx-1 flex w-full gap-1 overflow-x-auto sm:mx-0 sm:w-auto sm:flex-1">
            {NAV.map((item) => {
              const active = item.href === "/platform" ? pathname === item.href : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-md px-3 py-2 text-sm whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground",
                    active && "bg-muted text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 p-4 sm:p-6">
        {pathname !== "/platform" && (
          <Link
            href="/platform"
            className="-mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden /> Platform overview
          </Link>
        )}
        {children}
      </main>
    </div>
  );
}
