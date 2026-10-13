"use client";

import { useConvex } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { useCallback, useMemo } from "react";
import { useKioskDevice } from "./use-kiosk-device";

/**
 * Calls kiosk functions (`kioskQuery` / `kioskMutation`) with the paired
 * device token filled in. If the server answers NOT_FOUND, the token is
 * revoked or invalid, so the device is unpaired and `KioskDeviceGate` swaps
 * the screen for "This kiosk is not set up". The error is still rethrown so
 * the caller stops what it was doing.
 *
 * Use this (not `useQuery`/`useMutation` directly) for every kiosk call.
 */
type KioskArgs<F extends FunctionReference<"query" | "mutation">> = Omit<FunctionArgs<F>, "slug" | "token">;

export class KioskUnpairedError extends Error {
  constructor() {
    super("This kiosk is not set up.");
  }
}

export function errorCode(error: unknown): string | null {
  if (error instanceof ConvexError) {
    const data = error.data as { code?: unknown } | undefined;
    return typeof data?.code === "string" ? data.code : null;
  }
  return null;
}

/** A short message that is safe to show a visitor. Never includes server detail. */
export function friendlyKioskError(error: unknown): string {
  if (error instanceof KioskUnpairedError) return "This kiosk is not set up.";
  const code = errorCode(error);
  if (code === "RATE_LIMITED") return "Too many tries. Please wait a moment, or ask reception for help.";
  if (code === "VALIDATION" && error instanceof ConvexError) {
    const message = (error.data as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Something went wrong. Please try again, or ask reception for help.";
}

export function useKioskApi(slug: string) {
  const convex = useConvex();
  const device = useKioskDevice(slug);
  const { kiosk, unpair } = device;

  const guard = useCallback(
    async <T>(run: (auth: { slug: string; token: string }) => Promise<T>): Promise<T> => {
      if (kiosk === "skip") throw new KioskUnpairedError();
      try {
        return await run(kiosk);
      } catch (error) {
        if (errorCode(error) === "NOT_FOUND") {
          unpair();
          throw new KioskUnpairedError();
        }
        throw error;
      }
    },
    [kiosk, unpair],
  );

  const query = useCallback(
    <F extends FunctionReference<"query", "public">>(ref: F, args: KioskArgs<F>) =>
      guard((auth) => convex.query(ref, { ...args, ...auth } as FunctionArgs<F>)) as Promise<FunctionReturnType<F>>,
    [convex, guard],
  );

  const mutation = useCallback(
    <F extends FunctionReference<"mutation", "public">>(ref: F, args: KioskArgs<F>) =>
      guard((auth) => convex.mutation(ref, { ...args, ...auth } as FunctionArgs<F>)) as Promise<FunctionReturnType<F>>,
    [convex, guard],
  );

  return useMemo(() => ({ query, mutation, status: device.status }), [query, mutation, device.status]);
}
