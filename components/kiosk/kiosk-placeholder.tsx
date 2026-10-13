"use client";

import { KioskNav } from "./kiosk-nav";

export function KioskPlaceholder({ title, message }: { title: string; message: string }) {
  return (
    <div className="w-full max-w-xl space-y-6 rounded-2xl border bg-background p-8 text-center">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="text-lg text-muted-foreground">{message}</p>
      <KioskNav />
    </div>
  );
}
