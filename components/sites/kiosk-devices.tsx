"use client";

import { useMutation, useQuery } from "convex/react";
import { Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/auth/errors";
import { useActiveOrg } from "@/lib/org/active-org";

/** Per-gate kiosk devices: create, show the token once, list, revoke. */
export function KioskDevices({ gateId }: { gateId: Id<"gates"> }) {
  const { organizationId, org } = useActiveOrg();
  const devices = useQuery(api.kioskDevices.listByGate, { organizationId, gateId });
  const issue = useMutation(api.kioskDevices.issue);
  const revoke = useMutation(api.kioskDevices.revoke);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // Held in component state only; gone when this panel unmounts.
  const [issued, setIssued] = useState<{ token: string; name: string } | null>(null);

  const setupUrl = (token: string) =>
    `${window.location.origin}/kiosk/${org.slug}/setup#token=${encodeURIComponent(token)}`;

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error("Could not copy. Select the text and copy it manually.");
    }
  }

  async function create() {
    setBusy(true);
    try {
      const result = await issue({ organizationId, gateId, name });
      setIssued({ token: result.token, name: name.trim() });
      setName("");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t px-3 py-2 text-sm">
      <button
        type="button"
        className="font-medium text-primary underline-offset-4 hover:underline"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Kiosk devices{devices ? ` (${devices.filter((d) => d.status === "active").length})` : ""}
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          {issued && (
            <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3" role="status">
              <p className="font-medium">Setup code for {issued.name}</p>
              <p className="text-xs text-muted-foreground">
                Copy this now. For security it cannot be shown again.
              </p>
              <div className="flex gap-2">
                <Input readOnly aria-label="Setup code" value={issued.token} className="font-mono text-xs" />
                <Button type="button" variant="outline" onClick={() => copy(issued.token, "Code")}>
                  <Copy aria-hidden /> Copy code
                </Button>
              </div>
              <div className="flex gap-2">
                <Input
                  readOnly
                  aria-label="Kiosk setup URL"
                  value={setupUrl(issued.token)}
                  className="font-mono text-xs"
                />
                <Button type="button" variant="outline" onClick={() => copy(setupUrl(issued.token), "Link")}>
                  <Copy aria-hidden /> Copy link
                </Button>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setIssued(null)}>
                I have saved it
              </Button>
            </div>
          )}
          {devices === undefined ? null : devices.length === 0 ? (
            <p className="text-muted-foreground">No kiosk devices yet.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {devices.map((d) => (
                <li key={d._id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span>
                    {d.name}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {d.lastSeenAt ? `Last seen ${new Date(d.lastSeenAt).toLocaleString()}` : "Never used"}
                    </span>
                  </span>
                  {d.status === "revoked" ? (
                    <Badge variant="outline">Revoked</Badge>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={async () => {
                        if (!window.confirm(`Revoke "${d.name}"? That kiosk will stop working.`)) return;
                        try {
                          await revoke({ organizationId, deviceId: d._id });
                          toast.success("Device revoked");
                        } catch (e) {
                          toast.error(errorMessage(e));
                        }
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <Input
              aria-label="New kiosk device name"
              placeholder="Device name, e.g. Front desk tablet"
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" variant="secondary" disabled={busy || name.trim().length === 0}>
              Add device
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
