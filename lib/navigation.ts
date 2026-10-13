import {
  BarChart3,
  Building2,
  CalendarClock,
  ClipboardList,
  CreditCard,
  DoorOpen,
  FileText,
  LayoutDashboard,
  MessageSquare,
  Plug,
  ScrollText,
  Settings,
  UserCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Permission } from "@/lib/permissions";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown when the member holds any of these. Omit to show to everyone. */
  anyOf?: Permission[];
};

/**
 * Hiding a link is a convenience only; every page's data comes from Convex
 * functions that enforce the same permissions.
 */
export const APP_NAV: NavItem[] = [
  { href: "/app", label: "Dashboard", icon: LayoutDashboard },
  {
    href: "/app/appointments",
    label: "Appointments",
    icon: CalendarClock,
    anyOf: ["appointments:read_site", "appointments:read_own", "appointments:create"],
  },
  { href: "/app/visits", label: "Visits", icon: DoorOpen, anyOf: ["visits:read_site", "visits:check_in"] },
  { href: "/app/attendance", label: "Attendance", icon: UserCheck, anyOf: ["staff_attendance:read_own"] },
  { href: "/app/staff", label: "Staff", icon: ClipboardList, anyOf: ["staff_attendance:read_site"] },
  { href: "/app/team", label: "Team", icon: Users, anyOf: ["members:read"] },
  { href: "/app/sites", label: "Sites & gates", icon: Building2, anyOf: ["sites:read"] },
  { href: "/app/forms", label: "Forms", icon: FileText, anyOf: ["forms:manage"] },
  { href: "/app/reports", label: "Reports", icon: BarChart3, anyOf: ["reports:read"] },
  // P1
  { href: "/app/audit", label: "Audit log", icon: ScrollText, anyOf: ["audit:read"] },
  // end P1
  {
    href: "/app/messages",
    label: "Messages",
    icon: MessageSquare,
    anyOf: ["messages:read"],
  },
  { href: "/app/integrations", label: "Integrations", icon: Plug, anyOf: ["integrations:manage"] },
  { href: "/app/settings", label: "Settings", icon: Settings, anyOf: ["settings:manage"] },
  { href: "/app/billing", label: "Billing", icon: CreditCard, anyOf: ["billing:manage"] },
];
