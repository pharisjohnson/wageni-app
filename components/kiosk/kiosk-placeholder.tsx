/** Screen for kiosk steps that are planned but not built yet. Navigation comes from KioskNav. */
export function KioskPlaceholder({ title, message }: { title: string; message: string }) {
  return (
    <div className="w-full max-w-xl space-y-3 rounded-2xl border bg-background p-8 text-center">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="text-muted-foreground">{message}</p>
    </div>
  );
}
