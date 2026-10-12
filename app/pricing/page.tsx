import { PricingGrid } from "@/components/marketing/pricing-grid";
import { SiteFooter, SiteHeader } from "@/components/marketing/site-header";

export const metadata = { title: "Pricing" };

export default function PricingPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-8 px-4 py-16">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Pricing</h1>
          <p className="max-w-prose text-muted-foreground">
            Every plan starts with a free trial. Final pricing is being set; contact us for multi-site and
            enterprise requirements.
          </p>
        </div>
        <PricingGrid />
      </main>
      <SiteFooter />
    </>
  );
}
