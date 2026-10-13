"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/auth/errors";
import { useActiveOrg } from "@/lib/org/active-org";

type FileState = { fileId: Id<"files">; deleted: boolean; rejected: boolean; verified: boolean };
type Revealed = { id: string; label: string; value?: string; file?: FileState };

/** Opens one stored file in a new tab through an audited, permission-checked URL. */
function OpenFile({ file, label }: { file: FileState; label: string }) {
  const { organizationId } = useActiveOrg();
  const openFile = useMutation(api.forms.openFile);
  const [busy, setBusy] = useState(false);
  const { fileId } = file;
  if (file.rejected) {
    return <span className="text-destructive">Removed: the file did not pass the content check</span>;
  }
  if (file.deleted) return <span className="text-muted-foreground">Removed (retention period ended)</span>;
  // Files cannot be opened until their bytes were checked against the declared type.
  if (!file.verified) return <span className="text-muted-foreground">Being checked. Try again in a moment.</span>;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const { url } = await openFile({ organizationId, fileId });
          window.open(url, "_blank", "noopener,noreferrer");
        } catch (e) {
          toast.error(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Opening…" : `Open ${label.toLowerCase()}`}
    </Button>
  );
}

/** One answered form as returned by `forms.visitResponses` or `forms.staffResponses`. */
export type ResponseView = {
  responseId: Id<"formResponses">;
  formName: string;
  version: number;
  createdAt: number;
  canRevealSensitive: boolean;
  items: (
    | { id: string; label: string; sensitive: true }
    | { id: string; label: string; sensitive: false; value: string }
    | { id: string; label: string; sensitive: false; file: FileState }
  )[];
};

/**
 * Form answers for a visit. Sensitive answers are never in the query result:
 * a person with `forms:read_sensitive` can reveal them, which is audited.
 */
export function VisitResponses({ visitId }: { visitId: Id<"visits"> }) {
  const { organizationId } = useActiveOrg();
  const responses = useQuery(api.forms.visitResponses, { organizationId, visitId });
  if (!responses || responses.length === 0) return null;
  return <ResponseCards responses={responses as ResponseView[]} />;
}

/** The cards for a list of responses; shared by visits and staff pages. */
export function ResponseCards({ responses }: { responses: ResponseView[] }) {
  const { organizationId } = useActiveOrg();
  const reveal = useMutation(api.forms.revealSensitive);
  const [revealed, setRevealed] = useState<Record<string, Revealed[]>>({});
  return (
    <>
      {responses.map((r) => {
        const open = revealed[r.responseId];
        return (
          <Card key={r.responseId}>
            <CardHeader>
              <CardTitle>{r.formName}</CardTitle>
              <CardDescription>
                Version {r.version}, answered {new Date(r.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                {r.items.map((item) => {
                  const shown = item.sensitive ? open?.find((o) => o.id === item.id) : null;
                  return (
                    <div key={item.id}>
                      <dt className="text-muted-foreground">{item.label}</dt>
                      <dd>
                        {item.sensitive ? (
                          shown ? (
                            shown.file ? (
                              <OpenFile file={shown.file} label={item.label} />
                            ) : (
                              shown.value
                            )
                          ) : (
                            <span className="text-muted-foreground">Hidden (sensitive)</span>
                          )
                        ) : "file" in item && item.file ? (
                          <OpenFile file={item.file} label={item.label} />
                        ) : (
                          "value" in item && item.value
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              {r.canRevealSensitive && r.items.some((i) => i.sensitive) && !open && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      const items = await reveal({ organizationId, responseId: r.responseId });
                      setRevealed((s) => ({ ...s, [r.responseId]: items as Revealed[] }));
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  Show sensitive answers (this is logged)
                </Button>
              )}
            </CardContent>
          </Card>
        );
      })}
    </>
  );
}
