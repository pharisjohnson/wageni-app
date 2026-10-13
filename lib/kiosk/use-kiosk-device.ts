"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * Device pairing for public kiosks. The URL /kiosk/<slug> is public, so a
 * kiosk is trusted only by the per-gate device token an admin issued. The
 * token is stored in localStorage (it identifies the device, not a person;
 * no visitor data is ever stored here) and sent as `{ slug, token }` to
 * `kioskQuery` / `kioskMutation` functions. The server re-verifies it on
 * every call, so tampering with storage gains nothing.
 */
const keyFor = (slug: string) => `wageni.kioskToken.${slug.toLowerCase()}`;
const CHANGE_EVENT = "wageni:kiosk-token";

function read(slug: string): string | null {
  try {
    return window.localStorage.getItem(keyFor(slug));
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

export type KioskDeviceArgs = { slug: string; token: string };

export type KioskDevice = {
  /** "loading" only during hydration; then "paired" or "unpaired". */
  status: "loading" | "paired" | "unpaired";
  token: string | null;
  /**
   * Pass straight to a kiosk function; "skip" until paired:
   *   useQuery(api.kiosk.context, kiosk)
   */
  kiosk: KioskDeviceArgs | "skip";
  pair: (token: string) => boolean;
  unpair: () => void;
};

export function useKioskDevice(slug: string): KioskDevice {
  // Server snapshot is `undefined` (unknown) so hydration never mismatches.
  const token = useSyncExternalStore(
    subscribe,
    () => read(slug),
    () => undefined,
  );

  const pair = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return false;
      try {
        window.localStorage.setItem(keyFor(slug), trimmed);
      } catch {
        return false;
      }
      window.dispatchEvent(new Event(CHANGE_EVENT));
      return true;
    },
    [slug],
  );

  const unpair = useCallback(() => {
    try {
      window.localStorage.removeItem(keyFor(slug));
    } catch {
      // Nothing to clear.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, [slug]);

  return useMemo(
    () => ({
      status: token === undefined ? "loading" : token ? "paired" : "unpaired",
      token: token ?? null,
      kiosk: token ? { slug, token } : "skip",
      pair,
      unpair,
    }),
    [slug, token, pair, unpair],
  );
}
