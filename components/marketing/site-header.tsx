import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { appConfig } from "@/lib/config";

export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <Link href="/" className="text-lg font-semibold">
          {appConfig.name}
        </Link>
        <nav aria-label="Marketing" className="ml-auto flex items-center gap-1 sm:gap-2">
          <Link href="/#features" className={buttonVariants({ variant: "ghost", size: "sm", className: "hidden sm:inline-flex" })}>
            Features
          </Link>
          <Link href="/pricing" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Pricing
          </Link>
          <Link href="/sign-in" className={buttonVariants({ variant: "ghost", size: "sm" })}>
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
