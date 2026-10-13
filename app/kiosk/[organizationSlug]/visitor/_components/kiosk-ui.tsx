"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { CircleCheck } from "lucide-react";
import { useKioskOrg } from "@/components/kiosk/kiosk-frame";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import Link from "next/link";

/** Seconds a confirmation stays up before the kiosk returns to the welcome screen. */
export const DONE_SECONDS = 20;

/** Card used by every visitor kiosk screen. */
export function KioskPanel({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("w-full max-w-xl space-y-6 rounded-2xl border bg-background p-8", className)}>
      <h1 className="text-center text-3xl font-semibold tracking-tight">{title}</h1>
      {children}
    </div>
  );
}

/** Labelled, large text field with an inline error. */
export function KioskField({
  label,
  hint,
  error,
  id,
  className,
  ...props
}: { label: string; hint?: string; error?: string } & ComponentProps<"input"> & { id: string }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-lg">
        {label}
      </Label>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cn("h-14 px-4 text-lg md:text-lg", className)}
        {...props}
      />
      {hint && !error && (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-base text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Large primary action. */
export function KioskButton({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button size="lg" className={cn("min-h-14 px-8 text-lg", className)} {...props} />;
}

/** Visible, assertive message for something the visitor can fix or act on. */
export function KioskMessage({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-center text-lg">
      {children}
    </p>
  );
}

/**
 * Confirmation screen. Returns to the welcome screen after `DONE_SECONDS`
 * (the frame's idle reset only reacts to inactivity, and a confirmation would
 * otherwise sit there showing a badge code).
 */
export function KioskDone({ title, children }: { title: string; children: ReactNode }) {
  const { slug } = useKioskOrg();
  const router = useRouter();
  const home = `/kiosk/${slug}`;
  const [left, setLeft] = useState(DONE_SECONDS);

  useEffect(() => {
    const tick = window.setInterval(() => setLeft((n) => n - 1), 1000);
    return () => window.clearInterval(tick);
  }, []);
  useEffect(() => {
    if (left <= 0) router.replace(home);
  }, [left, router, home]);

  return (
    <div className="w-full max-w-xl space-y-6 rounded-2xl border bg-background p-8 text-center" role="status">
      <CircleCheck className="mx-auto size-16 text-primary" aria-hidden />
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <div className="space-y-3 text-xl">{children}</div>
      <Link href={home} className={cn(buttonVariants({ size: "lg" }), "min-h-14 px-8 text-lg")}>
        Done
      </Link>
      <p className="text-sm text-muted-foreground">Returning to the start screen in {Math.max(left, 0)}s.</p>
    </div>
  );
}
