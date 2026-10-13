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
            Starter is free. Business starts with a free trial. USD prices are being finalised and are charged by
            card through Stripe; contact us for enterprise requirements.
          </p>
        </div>
        <PricingGrid />
      </div>
    </MarketingShell>
  );
}
