import Link from "next/link";
import { Check } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { BUSINESS_TRIAL_LABEL, PLANS } from "@/lib/plans";
import { cn } from "@/lib/utils";

export function PricingGrid() {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {PLANS.map((plan) => (
        <Card key={plan.id} className={cn("rounded-3xl", plan.highlighted && "ring-2 ring-primary")}>
          <CardHeader>
            <CardTitle className="font-display text-xl font-bold">{plan.name}</CardTitle>
            <CardDescription>{plan.description}</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 space-y-4">
            <p className="font-display text-2xl font-bold">{plan.priceLabel}</p>
            <ul className="space-y-2 text-sm">
              {plan.features.map((f) => (
                <li key={f} className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  {f}
                </li>
              ))}
            </ul>
          </CardContent>
          <CardFooter>
            <Link
              href="/sign-up"
              className={buttonVariants({ variant: plan.highlighted ? "default" : "outline", className: "w-full" })}
            >
              {plan.tier === "free" ? "Get started free" : plan.tier === "business" ? `Start: ${BUSINESS_TRIAL_LABEL.toLowerCase()}` : "Get started, then contact us"}
            </Link>
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}
