import Link from "next/link";
import {
  CalendarCheck,
  ClipboardCheck,
  DoorOpen,
  FileSpreadsheet,
  ShieldCheck,
  Tablet,
  UserCheck,
  Users,
} from "lucide-react";
import { PricingGrid } from "@/components/marketing/pricing-grid";
import { SiteFooter, SiteHeader } from "@/components/marketing/site-header";
import { buttonVariants } from "@/components/ui/button";
import { appConfig } from "@/lib/config";

const FEATURES = [
  {
    icon: Tablet,
    title: "Branded visitor kiosk",
    body: "A tablet at reception or the gate where visitors register in seconds, with your logo and privacy notice.",
  },
  {
    icon: CalendarCheck,
    title: "Appointments and approvals",
    body: "Receptionists and hosts book visits; hosts approve or reject requests before anyone arrives.",
  },
  {
    icon: DoorOpen,
    title: "Fast gate check-in",
    body: "Guards see today's expected visitors, verify approval status and record entry and exit.",
  },
  {
    icon: UserCheck,
    title: "Staff attendance",
    body: "Secure clock-in and clock-out with an append-only history. Corrections are audited, never overwritten.",
  },
  {
    icon: ClipboardCheck,
    title: "Custom forms",
    body: "Collect exactly the information your policy requires, with versioned forms that keep history intact.",
  },
  {
    icon: FileSpreadsheet,
    title: "Reports and exports",
    body: "Searchable visitor registers and attendance reports, exported to CSV within each user's permissions.",
  },
  {
    icon: Users,
    title: "Roles that fit",
    body: "Owners, administrators, receptionists, guards, hosts and staff each see only what their job requires.",
  },
  {
    icon: ShieldCheck,
    title: "Secure by default",
    body: "Strict separation between organizations, server-side permission checks and a full audit trail.",
  },
];

function ProductPreview() {
  // Illustrative mock-up of the kiosk screen; contains no real data.
  return (
    <div
      aria-label="Illustration of the visitor kiosk"
      role="img"
      className="mx-auto w-full max-w-md rounded-2xl border bg-card p-4 shadow-sm"
    >
      <div className="rounded-xl bg-muted p-6 text-center">
        <div className="mx-auto mb-3 size-10 rounded-lg bg-primary/80" />
        <p className="font-semibold">Welcome to Example Ltd</p>
        <p className="text-sm text-muted-foreground">Please choose an option</p>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-primary py-6 font-medium text-primary-foreground">Visitor</div>
          <div className="rounded-lg border bg-background py-6 font-medium">Staff</div>
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main className="flex-1">
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 md:grid-cols-2 md:py-24">
          <div className="space-y-6">
            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              Know who is on site — visitors and staff.
            </h1>
            <p className="text-lg text-muted-foreground text-pretty">
              {appConfig.name} replaces paper visitor books, appointment diaries and unreliable attendance
              registers with one secure, searchable and auditable system for offices, schools, hospitals,
              factories and government agencies.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/sign-up" className={buttonVariants({ size: "lg" })}>
                Register your organization
              </Link>
              <Link href="/pricing" className={buttonVariants({ size: "lg", variant: "outline" })}>
                See pricing
              </Link>
            </div>
          </div>
          <ProductPreview />
        </section>

        <section id="features" className="border-t bg-muted/30">
          <div className="mx-auto max-w-6xl space-y-8 px-4 py-16">
            <h2 className="text-2xl font-semibold tracking-tight">Everything the front desk needs</h2>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {FEATURES.map((f) => (
                <div key={f.title} className="space-y-2">
                  <f.icon className="size-5 text-primary" aria-hidden />
                  <h3 className="font-medium">{f.title}</h3>
                  <p className="text-sm text-muted-foreground">{f.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl space-y-8 px-4 py-16">
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold tracking-tight">Plans</h2>
            <p className="text-muted-foreground">Start with a free trial. Plans and pricing are being finalised.</p>
          </div>
          <PricingGrid />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
