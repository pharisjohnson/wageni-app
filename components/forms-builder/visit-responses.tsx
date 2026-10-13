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

type Revealed = { id: string; label: string; value?: string; file?: { fileId: Id<"files">; deleted: boolean } };

/** Opens one stored file in a new tab through an audited, permission-checked URL. */
function OpenFile({ fileId, deleted, label }: { fileId: Id<"files">; deleted: boolean; label: string }) {
  const { organizationId } = useActiveOrg();
  const openFile = useMutation(api.forms.openFile);
  const [busy, setBusy] = useState(false);
  if (deleted) return <span className="text-muted-foreground">Removed (retention period ended)</span>;
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

/**
 * Form answers for a visit. Sensitive answers are never in the query result:
 * a person with `forms:read_sensitive` can reveal them, which is audited.
 */
export function VisitResponses({ visitId }: { visitId: Id<"visits"> }) {
  const { organizationId } = useActiveOrg();
  const responses = useQuery(api.forms.visitResponses, { organizationId, visitId });
  const reveal = useMutation(api.forms.revealSensitive);
  const [revealed, setRevealed] = useState<Record<string, Revealed[]>>({});

  if (!responses || responses.length === 0) return null;
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
                              <OpenFile fileId={shown.file.fileId} deleted={shown.file.deleted} label={item.label} />
                            ) : (
                              shown.value
                            )
                          ) : (
                            <span className="text-muted-foreground">Hidden (sensitive)</span>
                          )
                        ) : "file" in item && item.file ? (
                          <OpenFile fileId={item.file.fileId} deleted={item.file.deleted} label={item.label} />
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
