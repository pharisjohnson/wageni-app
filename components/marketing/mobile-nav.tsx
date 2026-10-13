"use client";

import Link from "next/link";
import { useState } from "react";
import { Menu } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/** Hamburger menu for the marketing header below the md breakpoint. */
export function MobileNav({ links }: { links: { href: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="icon" className="size-10" aria-label="Open menu" />}>
        <Menu />
      </SheetTrigger>
      <SheetContent side="right" className="w-72 p-4">
        <SheetTitle className="sr-only">Menu</SheetTitle>
        <nav aria-label="Mobile" className="mt-8 flex flex-col gap-1">
          {[...links, { href: "/sign-in", label: "Sign in" }].map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={close}
              className={buttonVariants({ variant: "ghost", className: "h-11 justify-start text-base" })}
            >
              {l.label}
            </Link>
          ))}
          <Link href="/sign-up" onClick={close} className={buttonVariants({ className: "mt-3 h-11 text-base" })}>
            Get started
          </Link>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
