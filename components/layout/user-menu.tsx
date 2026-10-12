"use client";

import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { useQuery } from "convex/react";
import { ShieldCheck } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";

/** Account controls. Provider-specific UI is confined to this component. */
export function UserMenu() {
  const me = useQuery(api.users.me);
  return (
    <div className="flex items-center gap-2">
      {me?.isPlatformAdmin && (
        <Link href="/platform" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <ShieldCheck aria-hidden /> Platform
        </Link>
      )}
      <UserButton />
    </div>
  );
}
