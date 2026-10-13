import Link from "next/link";
import { MarketingShell } from "@/components/marketing/site-header";
import { buttonVariants } from "@/components/ui/button";

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <MarketingShell>
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-4 py-24 text-center">
        <p className="text-sm font-medium text-muted-foreground">Error 404</p>
        <h1 className="font-display text-4xl font-extrabold tracking-tight">Page not found</h1>
        <p className="text-muted-foreground">This page does not exist or has moved.</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Link href="/" className={buttonVariants({ size: "lg" })}>
            Back to home
          </Link>
          <Link href="/app" className={buttonVariants({ size: "lg", variant: "outline" })}>
            Go to the app
          </Link>
        </div>
      </div>
    </MarketingShell>
  );
}
