import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  CalendarCheck,
  Camera,
  CircleCheck,
  ClipboardList,
  Clock,
  DoorOpen,
  FileText,
  Handshake,
  ScanLine,
  ShieldCheck,
  Tablet,
  X,
  type LucideIcon,
} from "lucide-react";
import { MarketingShell } from "@/components/marketing/site-header";
import { PricingGrid } from "@/components/marketing/pricing-grid";
import { buttonVariants } from "@/components/ui/button";
import { appConfig } from "@/lib/config";

type Feature = { icon: LucideIcon; title: string; body: string; soon?: boolean };

const PAIN = [
  "Paper registers nobody can search, and pages that go missing",
  "Illegible handwriting and made-up phone numbers",
  "Hosts who never learn their visitor has arrived",
  "Staff sign-in books filled in at the end of the week",
  "No proof of who was on site when something goes wrong",
];

const FEATURES: Feature[] = [
  {
    icon: ClipboardList,
    title: "Visitor registration",
    body: "Visitors register themselves, are pre-registered by a host, or are signed in by reception in seconds.",
  },
  {
    icon: CalendarCheck,
    title: "Appointments & approvals",
    body: "Hosts approve or decline requests. Everyone knows who is expected, and when.",
  },
  {
    icon: DoorOpen,
    title: "Gate check-in & out",
    body: "Guards see expected arrivals, admit visitors and keep a live list of everyone on site.",
  },
  {
    icon: Clock,
    title: "Staff attendance",
    body: "Staff check in and out each day, with corrections that are requested and approved, never silently edited.",
    soon: true,
  },
  {
    icon: Building2,
    title: "Sites & gates",
    body: "Run several locations and entrances under one organization, with access limited per site.",
  },
  {
    icon: ShieldCheck,
    title: "Audit trail",
    body: "Check-ins, check-outs and changes are recorded with who did them and when.",
  },
];

const STEPS = [
  { title: "Arrive", body: "The visitor books ahead, or taps their way through the kiosk. Reception can do it for them." },
  { title: "Approve", body: "The host is told and approves or declines. No phone calls across the building." },
  { title: "Admit", body: "The guard sees an expected visitor, checks them in and hands over a badge code." },
  { title: "Finish", body: "When the meeting ends, the host checks the visitor out in one tap. The gate sees it instantly." },
];

const ROLES = [
  ["Owners & admins", "Set up sites, forms, people and rules. See everything for their organization."],
  ["Receptionists", "Register walk-ins, check people in and out, and book on behalf of hosts."],
  ["Guards", "Work from the live expected and on-site lists at their own gate."],
  ["Hosts", "Approve visits, see who is waiting and close the meeting when it is done."],
  ["Staff", "Check in and out, and see their own attendance."],
  ["Visitors", "Register once on the kiosk or a link. No account needed."],
];

const FORM_FIELDS = [
  "Text, number, phone, email, date",
  "Single and multiple choice, yes/no",
  "Consent with the exact wording shown",
  "Signature",
  "Photo or file upload",
  "ID photo that fills the form",
  "Face photo for the badge",
];

const FAQ = [
  {
    q: "Do visitors need to create an account?",
    a: "No. Visitors use the kiosk or a link from their host. Only your staff sign in.",
  },
  {
    q: "What if the internet drops?",
    a: "Wageni is an online service, so the kiosk needs a connection. Reception can keep working from any signed-in device, and we are planning offline handling as part of hardening before general release.",
  },
  {
    q: "Is our data kept separate from other organizations?",
    a: "Yes. Every record belongs to one organization and every request is checked against the signed-in person's role and site access on the server, not just in the screen.",
  },
  {
    q: "What happens to IDs and photos?",
    a: "You choose per form. Reading an ID to fill the form and then discarding the image will be the default; storing it is a switch you turn on, with a retention period you set. Face features are opt-in and off by default.",
  },
  {
    q: "Can we run it on a tablet at the door?",
    a: "Yes. The kiosk is a web page that works on any tablet or screen, branded with your logo, colour and welcome message. It resets itself after a period of inactivity so one person's details are never left on screen for the next.",
  },
  {
    q: "What does it cost?",
    a: "Every plan starts with a free trial. Final prices are still being set, and early users will be asked for their feedback in return for preferred terms.",
  },
];

export default function HomePage() {
  return (
    <MarketingShell>
      {/* Hero */}
      <section className="mx-auto max-w-4xl space-y-8 px-4 pt-16 pb-20 text-center md:pt-24">
        <p className="mx-auto w-fit rounded-full bg-secondary px-3.5 py-1.5 text-sm">
          Early access · For offices, schools, hospitals, factories &amp; residences
        </p>
        <h1 className="font-display text-4xl leading-[1.05] font-extrabold tracking-tight text-balance sm:text-6xl lg:text-7xl">
          Know who is on your premises, and who they came to see
        </h1>
        <p className="mx-auto max-w-2xl text-lg text-muted-foreground text-pretty">
          {appConfig.name} replaces paper visitor books and attendance registers with one simple system:
          from the first appointment request to the host closing the meeting at the end.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link href="/sign-up" className={buttonVariants({ size: "lg" })}>
            Get early access <ArrowRight aria-hidden />
          </Link>
          <Link href="#how-it-works" className={buttonVariants({ size: "lg", variant: "outline" })}>
            See how it works
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">Free trial. No card needed to start.</p>
      </section>

      {/* Problem */}
      <section className="mx-auto max-w-6xl px-4 pb-20">
        <div className="grid items-center gap-10 rounded-3xl bg-(--brand-ink) p-8 text-white md:grid-cols-2 md:p-12">
          <div className="space-y-4">
            <h2 className="font-display text-3xl leading-tight font-extrabold tracking-tight text-balance sm:text-4xl">
              The visitor book was never built for this
            </h2>
            <p className="text-white/75">
              It works until someone asks who was here last Tuesday, or whether the contractor ever left.
            </p>
          </div>
          <ul className="space-y-3">
            {PAIN.map((p) => (
              <li key={p} className="flex items-start gap-3">
                <X className="mt-1 size-4 shrink-0 text-(--brand-amber)" aria-hidden />
                <span className="text-white/90">{p}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="scroll-mt-20 mx-auto max-w-6xl space-y-10 px-4 pb-20">
        <div className="max-w-2xl space-y-3">
          <h2 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">
            From arrival to a closed meeting
          </h2>
          <p className="text-muted-foreground">Four steps, and each one is recorded.</p>
        </div>
        <ol className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="space-y-3 rounded-3xl border bg-card p-6">
              <span className="flex size-9 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground">
                {i + 1}
              </span>
              <h3 className="font-display text-xl font-bold">{s.title}</h3>
              <p className="text-muted-foreground">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Host checkout */}
      <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-20 md:grid-cols-2">
        <div className="space-y-4">
          <span className="flex size-12 items-center justify-center rounded-xl bg-secondary">
            <Handshake className="size-6" aria-hidden />
          </span>
          <h2 className="font-display text-3xl font-extrabold tracking-tight text-balance sm:text-4xl">
            Hosts close the meeting. Visitors walk straight out.
          </h2>
          <p className="text-muted-foreground">
            When the meeting ends, the host checks the visitor out from their own phone or screen. The guard
            sees &ldquo;cleared by host&rdquo; at once, so nobody queues at the gate to be processed.
          </p>
          <p className="text-muted-foreground">
            It is also your proof of the meeting: who the visitor saw, when they arrived, and who confirmed
            they left.
          </p>
        </div>
        <div className="space-y-3 rounded-3xl border bg-card p-6">
          {[
            ["08:52", "Checked in at Main Gate"],
            ["09:00", "Meeting with host"],
            ["10:15", "Meeting ended, confirmed by host"],
            ["10:15", "Visitor cleared at the gate"],
          ].map(([time, event]) => (
            <div key={event} className="flex items-center gap-4 rounded-xl bg-muted px-4 py-3">
              <span className="font-mono text-sm text-muted-foreground">{time}</span>
              <span className="font-medium">{event}</span>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">Illustration of a visit timeline.</p>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="scroll-mt-20 mx-auto max-w-6xl space-y-10 px-4 pb-20">
        <div className="max-w-2xl space-y-3">
          <h2 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">
            Everything the front desk and the gate need
          </h2>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="space-y-3 rounded-3xl border bg-card p-6">
              <span className="flex size-12 items-center justify-center rounded-xl bg-secondary text-foreground">
                <f.icon className="size-6" aria-hidden />
              </span>
              <h3 className="font-display text-xl font-bold tracking-tight">
                {f.title}
                {f.soon && (
                  <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 align-middle text-xs font-medium">
                    Coming soon
                  </span>
                )}
              </h3>
              <p className="text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Kiosk */}
      <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-20 md:grid-cols-2">
        <div className="order-2 grid grid-cols-2 gap-4 md:order-1">
          <div className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-2xl bg-primary p-4 text-center font-semibold text-primary-foreground">
            <Tablet className="size-8" aria-hidden /> Visitor
          </div>
          <div className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-2xl border bg-card p-4 text-center font-semibold">
            <BadgeCheck className="size-8" aria-hidden /> Staff
          </div>
        </div>
        <div className="order-1 space-y-4 md:order-2">
          <h2 className="font-display text-3xl font-extrabold tracking-tight text-balance sm:text-4xl">
            A branded kiosk, or a receptionist, or both
          </h2>
          <p className="text-muted-foreground">
            Put a tablet at the door with your logo and welcome message. Visitors and staff each get their own
            path, every screen has a Back button, and it resets itself after a quiet spell. Prefer a person at
            a desk? Reception does the same job from their own screen.
          </p>
        </div>
      </section>

      {/* Forms */}
      <section className="mx-auto max-w-6xl px-4 pb-20">
        <div className="grid gap-10 rounded-3xl border bg-card p-8 md:grid-cols-2 md:p-12">
          <div className="space-y-4">
            <span className="flex size-12 items-center justify-center rounded-xl bg-secondary">
              <FileText className="size-6" aria-hidden />
            </span>
            <h2 className="font-display text-3xl font-extrabold tracking-tight text-balance sm:text-4xl">
              Ask for exactly what you need, nothing more
            </h2>
            <p className="text-muted-foreground">
              Admins build their own forms with the field types they want. A reception desk may need only a
              name and a purpose; a clinic or a plant may need much more.
            </p>
            <p className="inline-flex items-center gap-2 rounded-full bg-secondary px-3 py-1 text-sm font-medium">
              Form builder: coming at launch
            </p>
          </div>
          <div className="space-y-5">
            <ul className="grid gap-2">
              {FORM_FIELDS.map((f) => (
                <li key={f} className="flex items-center gap-2.5">
                  <CircleCheck className="size-5 shrink-0 text-primary" aria-hidden />
                  {f}
                </li>
              ))}
            </ul>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1 rounded-2xl bg-muted p-4">
                <ScanLine className="size-5" aria-hidden />
                <p className="font-semibold">Scan the ID, skip the typing</p>
                <p className="text-sm text-muted-foreground">
                  Photograph an ID and the name and number fill in. The visitor checks them before submitting.
                </p>
              </div>
              <div className="space-y-1 rounded-2xl bg-muted p-4">
                <Camera className="size-5" aria-hidden />
                <p className="font-semibold">Face photo</p>
                <p className="text-sm text-muted-foreground">
                  Optional, with consent, and off unless you turn it on.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Roles */}
      <section className="mx-auto max-w-6xl space-y-10 px-4 pb-20">
        <h2 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">
          Built for every person at the door
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ROLES.map(([role, body]) => (
            <div key={role} className="space-y-1.5 rounded-2xl border bg-card p-5">
              <p className="font-display text-lg font-bold">{role}</p>
              <p className="text-sm text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Trust */}
      <section className="mx-auto max-w-6xl px-4 pb-20">
        <div className="grid gap-8 rounded-3xl bg-(--brand-ink) p-8 text-white md:grid-cols-3 md:p-12">
          <div className="space-y-2 md:col-span-1">
            <ShieldCheck className="size-8 text-(--brand-amber)" aria-hidden />
            <h2 className="font-display text-3xl font-extrabold tracking-tight text-balance">
              Personal data, handled with care
            </h2>
          </div>
          <ul className="space-y-3 md:col-span-2">
            {[
              "Each organization's data is separated, and every request is checked on the server.",
              "Roles decide who sees what, and access can be limited to particular sites.",
              "Visit and attendance history is append-only: corrections are recorded, not overwritten.",
              "You decide what to collect and how long to keep it.",
              "Kiosk screens clear themselves after inactivity.",
            ].map((t) => (
              <li key={t} className="flex items-start gap-3">
                <CircleCheck className="mt-0.5 size-5 shrink-0 text-(--brand-amber)" aria-hidden />
                <span className="text-white/90">{t}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Early access */}
      <section className="mx-auto max-w-3xl space-y-4 px-4 pb-20 text-center">
        <h2 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">
          Help shape it before launch
        </h2>
        <p className="text-muted-foreground">
          We are working with a small group of first organizations. Early users get a free trial, a direct line
          to the team, and a say in what we build next.
        </p>
      </section>

      {/* FAQ */}
      <section id="faq" className="scroll-mt-20 mx-auto max-w-3xl space-y-6 px-4 pb-20">
        <h2 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">Questions</h2>
        <div className="divide-y rounded-2xl border bg-card">
          {FAQ.map((f) => (
            <details key={f.q} className="group px-5 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                {f.q}
                <span className="text-muted-foreground transition-transform group-open:rotate-45" aria-hidden>
                  +
                </span>
              </summary>
              <p className="mt-2 text-muted-foreground">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* Plans */}
      <section id="pricing" className="scroll-mt-20 mx-auto max-w-6xl space-y-8 px-4 pb-20">
        <div className="space-y-2">
          <h2 className="font-display text-3xl font-extrabold tracking-tight">Plans</h2>
          <p className="text-muted-foreground">Start with a free trial. Plans and pricing are being finalised.</p>
        </div>
        <PricingGrid />
      </section>

      {/* Final CTA */}
      <section className="mx-auto max-w-4xl space-y-6 px-4 pb-24 text-center">
        <h2 className="font-display text-3xl font-extrabold tracking-tight text-balance sm:text-5xl">
          Retire the paper book
        </h2>
        <div className="flex flex-wrap justify-center gap-3">
          <Link href="/sign-up" className={buttonVariants({ size: "lg" })}>
            Get early access <ArrowRight aria-hidden />
          </Link>
          <Link href="/sign-in" className={buttonVariants({ size: "lg", variant: "outline" })}>
            Sign in
          </Link>
        </div>
      </section>
    </MarketingShell>
  );
}
