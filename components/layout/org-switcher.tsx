"use client";

import Link from "next/link";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ROLE_LABELS } from "@/lib/permissions";
import { useActiveOrg } from "@/lib/org/active-org";

export function OrgSwitcher() {
  const { org, organizations, switchTo } = useActiveOrg();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" className="h-auto w-full justify-between py-2 text-left" />}
      >
        <span className="min-w-0">
          <span className="block truncate font-medium">{org.name}</span>
          <span className="block text-xs text-muted-foreground">{ROLE_LABELS[org.membership.role]}</span>
        </span>
        <ChevronsUpDown className="text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          {organizations.map((o) => (
            <DropdownMenuItem key={o.organizationId} onClick={() => switchTo(o.organizationId)}>
              <span className="flex-1 truncate">{o.name}</span>
              {o.organizationId === org._id && <Check aria-label="Current" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/onboarding" />}>
          <Plus aria-hidden /> New organization
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
