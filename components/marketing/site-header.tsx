import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { appConfig } from "@/lib/config";
import { MobileNav } from "./mobile-nav";

const MARKETING_LINKS = [
  { href: "/#features", label: "Features" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/pricing", label: "Pricing" },
  { href: "/#faq", label: "FAQ" },
];

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
    <header className="sticky top-0 z-40 bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4">
        <Link href="/" aria-label={`${appConfig.name} home`}>
          <BrandMark />
        </Link>
        <nav aria-label="Marketing" className="ml-auto hidden items-center gap-2 md:flex">
          {MARKETING_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              {l.label}
            </Link>
          ))}
          <Link href="/sign-in" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Sign in
          </Link>
          <Link href="/sign-up" className={buttonVariants({ size: "sm" })}>
            Get started
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-2 md:hidden">
          <Link href="/sign-up" className={buttonVariants({ size: "sm" })}>
            Get started
          </Link>
          <MobileNav links={MARKETING_LINKS} />
        </div>
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
