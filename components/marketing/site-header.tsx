import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { appConfig } from "@/lib/config";

/** Page frame for the public marketing site: applies the marketing theme, header and footer. */
export function MarketingShell({ children }: { children: ReactNode }) {
  return (
    <div className="theme-marketing flex min-h-full flex-1 flex-col">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}

export function BrandMark() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <ShieldCheck className="size-5" aria-hidden />
      </span>
      <span className="font-display text-xl font-bold tracking-tight">{appConfig.name}</span>
    </span>
  );
}

export function SiteHeader() {
  return (
    <header>
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4">
        <Link href="/" aria-label={`${appConfig.name} home`}>
          <BrandMark />
        </Link>
        <nav aria-label="Marketing" className="ml-auto flex items-center gap-1 sm:gap-2">
          <Link href="/#features" className={buttonVariants({ variant: "ghost", size: "sm", className: "max-sm:hidden" })}>
            Features
          </Link>
          <Link href="/pricing" className={buttonVariants({ variant: "ghost", size: "sm", className: "max-sm:hidden" })}>
            Pricing
          </Link>
          <Link href="/sign-in" className={buttonVariants({ variant: "ghost", size: "sm", className: "max-sm:hidden" })}>
            Sign in
          </Link>
          <Link href="/sign-up" className={buttonVariants({ size: "sm" })}>
            Get started
          </Link>
        </nav>
      </div>
    </header>
  );
}

async function CopyrightYear() {
  "use cache";
  return <>{new Date().getFullYear()}</>;
}

export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:justify-between">
        <p>
          © <CopyrightYear /> {appConfig.name}
        </p>
        <p>{appConfig.tagline}</p>
      </div>
    </footer>
  );
}
