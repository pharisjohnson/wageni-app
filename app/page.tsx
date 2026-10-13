import Link from "next/link";
import {
  ArrowRight,
  CalendarCheck,
  CircleCheck,
  ClipboardList,
  Clock,
  DoorOpen,
  ShieldCheck,
  Building2,
} from "lucide-react";
import { MarketingShell } from "@/components/marketing/site-header";
import { PricingGrid } from "@/components/marketing/pricing-grid";
import { buttonVariants } from "@/components/ui/button";
import { appConfig } from "@/lib/config";

const FEATURES = [
  {
    icon: ClipboardList,
    title: "Visitor registration",
    body: "Visitors pre-register from a link, or reception books them in seconds. No more paper logs.",
  },
  {
    icon: CalendarCheck,
    title: "Appointments & approvals",
    body: "Hosts approve or decline visit requests. Everyone knows who is expected, and when.",
  },
  {
    icon: DoorOpen,
    title: "Gate check-in & out",
    body: "Guards see expected arrivals, check visitors in and out, and keep a live on-site list.",
  },
  {
    icon: Clock,
    title: "Staff attendance",
    body: "Staff check in and out daily. Accurate attendance records replace unreliable sign-in books.",
  },
  {
    icon: Building2,
    title: "Sites & gates",
    body: "Run multiple locations and entrances under one organization with role-based access.",
  },
  {
    icon: ShieldCheck,
    title: "Auditable & secure",
    body: "Every action is recorded. Data is isolated per organization and protected by roles.",
  },
];

const STEPS = [
  "Visitor requests an appointment or walks in",
  "Host or receptionist approves the visit",
  "Guard checks the visitor in at the gate",
  "Check-out closes the visit with a full audit trail",
];

const ROLES = ["Owners & admins", "Receptionists", "Guards", "Hosts", "Staff", "Visitors"];

export default function HomePage() {
  return (
    <MarketingShell>
      <section className="mx-auto max-w-4xl space-y-8 px-4 pt-16 pb-20 text-center md:pt-24">
        <p className="mx-auto w-fit rounded-full bg-secondary px-3.5 py-1.5 text-sm">
          For offices, schools, hospitals, factories &amp; residences
        </p>
        <h1 className="font-display text-4xl leading-[1.05] font-extrabold tracking-tight text-balance sm:text-6xl lg:text-7xl">
          The front desk your organization deserves
        </h1>
        <p className="mx-auto max-w-2xl text-lg text-muted-foreground text-pretty">
          {appConfig.name} replaces paper visitor registers and manual attendance books with a secure,
          searchable, auditable digital system — from appointment request to gate check-out.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link href="/sign-up" className={buttonVariants({ size: "lg" })}>
            Create your organization <ArrowRight aria-hidden />
          </Link>
          <Link href="/sign-in" className={buttonVariants({ size: "lg", variant: "outline" })}>
            Sign in
          </Link>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-6xl px-4 pb-20">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="space-y-3 rounded-3xl border bg-card p-6">
              <span className="flex size-12 items-center justify-center rounded-xl bg-secondary text-foreground">
                <f.icon className="size-6" aria-hidden />
              </span>
              <h2 className="font-display text-xl font-bold tracking-tight">{f.title}</h2>
              <p className="text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-20 md:grid-cols-2">
        <div className="space-y-6">
          <h2 className="font-display text-4xl leading-tight font-extrabold tracking-tight text-balance">
            From request to check-out, one flow
          </h2>
          <ol className="space-y-4">
            {STEPS.map((step, i) => (
              <li key={step} className="flex items-center gap-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground">
                  {i + 1}
                </span>
                <span className="text-lg text-muted-foreground">{step}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="rounded-3xl bg-(--brand-ink) p-8 text-white">
          <h3 className="font-display mb-5 text-2xl font-bold">Built for every role</h3>
          <ul className="grid gap-3 sm:grid-cols-2">
            {ROLES.map((role) => (
              <li key={role} className="flex items-center gap-2.5 rounded-xl bg-white/8 px-4 py-3">
                <CircleCheck className="size-5 shrink-0 text-(--brand-amber)" aria-hidden />
                {role}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-6xl space-y-8 px-4 pb-24">
        <div className="space-y-2">
          <h2 className="font-display text-3xl font-extrabold tracking-tight">Plans</h2>
          <p className="text-muted-foreground">Start with a free trial. Plans and pricing are being finalised.</p>
        </div>
        <PricingGrid />
      </section>
    </MarketingShell>
  );
}
