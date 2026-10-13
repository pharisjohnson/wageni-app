import { PricingGrid } from "@/components/marketing/pricing-grid";
import { MarketingShell } from "@/components/marketing/site-header";

export const metadata = { title: "Pricing" };

export default function PricingPage() {
  return (
    <MarketingShell>
      <div className="mx-auto w-full max-w-6xl space-y-10 px-4 py-16">
        <div className="space-y-3 text-center">
          <h1 className="font-display text-4xl font-extrabold tracking-tight sm:text-5xl">Pricing</h1>
          <p className="mx-auto max-w-prose text-muted-foreground">
            Every plan starts with a free trial. Final pricing is being set; contact us for multi-site and
            enterprise requirements.
          </p>
        </div>
        <PricingGrid />
      </div>
    </MarketingShell>
  );
}
