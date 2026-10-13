"use client";

import { useConvex } from "convex/react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { useKioskOrg } from "@/components/kiosk/kiosk-frame";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import { useKioskDevice } from "@/lib/kiosk/use-kiosk-device";

/**
 * Device pairing. An admin creates a kiosk device under Sites & gates and
 * opens this page (the setup link carries the token in the URL fragment,
 * which is never sent to a server). Nothing personal is stored.
 */
export default function KioskSetupPage() {
  const org = useKioskOrg();
  const device = useKioskDevice(org.slug);
  const convex = useConvex();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [site, setSite] = useState<{ siteName: string; gateName: string } | null>(null);

  useEffect(() => {
    const match = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time prefill from the URL fragment
    if (match) setValue(decodeURIComponent(match[1]!));
  }, []);

  async function pair() {
    setError(null);
    setBusy(true);
    const token = value.trim();
    try {
      const ctx = await convex.query(api.kiosk.context, { slug: org.slug, token });
      if (!device.pair(token)) throw new Error("storage");
      window.history.replaceState(null, "", window.location.pathname);
      setSite(ctx);
      setValue("");
    } catch {
      setError("That code did not work. Check it and try again, or ask an administrator for a new one.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-xl space-y-6 rounded-2xl border bg-background p-8 text-center">
      <h1 className="text-2xl font-semibold">Kiosk setup</h1>
      {site ? (
        <p role="status" className="text-muted-foreground">
          This kiosk is set up for {site.gateName} at {site.siteName}.
        </p>
      ) : device.status === "paired" ? (
        <div className="space-y-3">
          <p className="text-muted-foreground">This kiosk is already set up.</p>
          <Button variant="outline" onClick={device.unpair}>
            Remove setup from this device
          </Button>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void pair();
          }}
        >
          <p className="text-muted-foreground">Enter the setup code from your administrator.</p>
          <Input
            aria-label="Setup code"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" size="lg" disabled={busy || value.trim().length === 0}>
            {busy ? "Checking…" : "Set up this kiosk"}
          </Button>
        </form>
      )}
      <Link href={`/kiosk/${org.slug}`} className={buttonVariants({ size: "lg", variant: "outline" })}>
        <ArrowLeft aria-hidden /> Back
      </Link>
    </div>
  );
}
