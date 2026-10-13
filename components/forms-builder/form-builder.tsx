"use client";

import { useMutation, useQuery } from "convex/react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Field } from "@/components/forms/field";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/auth/errors";
import { useActiveOrg } from "@/lib/org/active-org";
import {
  FIELD_TYPE_LABELS,
  formFieldSchema,
  formFieldsSchema,
  publishProblems,
  type FieldType,
  type FormField,
} from "@/lib/validation/forms";
import { cleanField, fieldTypesFor, moveItem, newField, type DraftField } from "./builder-utils";
import { FieldEditor } from "./field-editor";
import { FormPreview } from "./form-preview";

/** Per-field problems from the shared schema, keyed by field index. */
function fieldProblems(fields: DraftField[]) {
  const res = formFieldsSchema.safeParse(fields.map(cleanField));
  const byIndex = new Map<number, string>();
  if (!res.success) {
    for (const issue of res.error.issues) {
      const index = typeof issue.path[0] === "number" ? issue.path[0] : -1;
      if (!byIndex.has(index)) byIndex.set(index, issue.message);
    }
  }
  return { parsed: res.success ? (res.data as FormField[]) : null, byIndex };
}

type Detail = NonNullable<ReturnType<typeof useDetail>>;
function useDetail(formId: Id<"forms">) {
  const { organizationId } = useActiveOrg();
  return useQuery(api.forms.get, { organizationId, formId });
}

export function FormBuilder({ formId }: { formId: Id<"forms"> }) {
  const form = useDetail(formId);
  const back = { href: "/app/forms", label: "Back to forms" };
  if (form === undefined) {
    return (
      <>
        <PageHeader title="Form" back={back} />
        <Skeleton className="h-64 w-full" />
      </>
    );
  }
  // Remount the editor if the form is replaced wholesale (archive/restore does not).
  return <BuilderInner key={form._id} form={form} />;
}

function BuilderInner({ form }: { form: Detail }) {
  const { organizationId } = useActiveOrg();
  const sites = useQuery(api.sites.list, { organizationId });
  const saveDraft = useMutation(api.forms.saveDraft);
  const publish = useMutation(api.forms.publish);
  const archive = useMutation(api.forms.archive);
  const restore = useMutation(api.forms.restore);

  const [fields, setFields] = useState<DraftField[]>(() => form.draftFields as DraftField[]);
  const [selected, setSelected] = useState<string | null>(null);
  const [addType, setAddType] = useState<FieldType>("short_text");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const details = useForm({
    defaultValues: { name: form.name, purpose: form.purpose ?? "", siteId: form.siteId ?? "" },
  });
  const archived = form.status === "archived";

  const { parsed, byIndex } = useMemo(() => fieldProblems(fields), [fields]);
  const problems = useMemo(
    () => (parsed ? publishProblems(parsed, { audience: form.audience, faceCaptureEnabled: form.faceCaptureEnabled }) : []),
    [parsed, form.audience, form.faceCaptureEnabled],
  );
  // The preview shows every field that is valid so far, even while others are being fixed.
  const previewFields = useMemo(
    () =>
      fields.flatMap((f) => {
        const r = formFieldSchema.safeParse(cleanField(f));
        return r.success ? [r.data as FormField] : [];
      }),
    [fields],
  );
  const selectedIndex = fields.findIndex((f) => f.id === selected);
  const selectedField = selectedIndex >= 0 ? fields[selectedIndex]! : null;

  const update = useCallback((next: DraftField) => {
    setFields((fs) => fs.map((f) => (f.id === next.id ? next : f)));
    setDirty(true);
  }, []);

  function add() {
    const f = newField(addType, fields.map((x) => x.id));
    setFields((fs) => [...fs, f]);
    setSelected(f.id);
    setDirty(true);
  }
  function remove(id: string) {
    setFields((fs) => fs.filter((f) => f.id !== id));
    // Fields that depended on it lose their rule.
    setFields((fs) => fs.map((f) => (f.showIf?.fieldId === id ? { ...f, showIf: undefined } : f)));
    if (selected === id) setSelected(null);
    setDirty(true);
  }
  function move(i: number, to: number) {
    setFields((fs) => moveItem(fs, i, to));
    setDirty(true);
  }

  async function save(): Promise<boolean> {
    if (!parsed) {
      toast.error("Fix the highlighted fields before saving.");
      return false;
    }
    const values = details.getValues();
    try {
      await saveDraft({
        organizationId,
        formId: form._id,
        name: values.name,
        purpose: values.purpose || undefined,
        siteId: (values.siteId || undefined) as Id<"sites"> | undefined,
        fields: parsed as Doc<"forms">["draftFields"],
      });
      setDirty(false);
      details.reset(values);
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    }
  }

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const unsaved = dirty || details.formState.isDirty;
  const live = form.publishedVersionId ? form.history.find((h) => h._id === form.publishedVersionId) : undefined;

  return (
    <>
      <PageHeader
        title={form.name}
        back={{ href: "/app/forms", label: "Back to forms" }}
        description={
          form.audience === "visitor"
            ? "Visitor form: asked at the kiosk and on invitation links."
            : "Staff form: asked when staff clock in (kiosk and Attendance page)."
        }
        actions={
          <>
            <Badge variant={form.status === "published" ? "default" : "secondary"}>
              {form.status === "published" ? `Live: version ${live?.version ?? "?"}` : form.status}
            </Badge>
            {form.status === "published" && (unsaved || form.hasUnpublishedChanges) && <Badge variant="outline">Unpublished changes</Badge>}
            <Badge variant={form.audience === "staff" ? "secondary" : "outline"}>
              {form.audience === "staff" ? "Staff form" : "Visitor form"}
            </Badge>
          </>
        }
      />

      {archived && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-4">
            <p className="text-sm text-muted-foreground">This form is archived and is not shown to visitors. Restore it to edit or publish.</p>
            <Button disabled={busy} onClick={() => run(() => restore({ organizationId, formId: form._id }), "Form restored")}>
              Restore
            </Button>
          </CardContent>
        </Card>
      )}

      {form.audience === "staff" && (
        <Card>
          <CardContent className="space-y-1 pt-4 text-sm">
            <p className="font-medium">How a staff form works</p>
            <p className="text-muted-foreground">
              While this form is published for a site, staff must answer it every time they clock in at that site (kiosk and Attendance
              page). Clocking out never asks. Answers are stored against the person and that clock-in, and managers can read them on the
              person&apos;s page in Staff. File, photo, signature and ID fields are not available, and nothing here fills a visit record.
              Sensitive answers stay hidden until someone with the sensitive-data permission reveals them (logged).
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field id="fd-name" label="Name">
            <Input id="fd-name" disabled={archived} {...details.register("name")} />
          </Field>
          <Field id="fd-purpose" label="Purpose (optional)">
            <Input id="fd-purpose" disabled={archived} {...details.register("purpose")} />
          </Field>
          <Field
            id="fd-site"
            label="Site"
            help={form.audience === "staff" ? "Staff at other sites are not asked this form." : "Visitors at other sites will not see this form."}
          >
            <NativeSelect id="fd-site" disabled={archived} {...details.register("siteId")}>
              <option value="">All sites</option>
              {sites?.map((s) => (
                <option key={s._id} value={s._id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Fields</CardTitle>
            <CardDescription>Use the arrow buttons to reorder. Select a field to edit it.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {fields.length === 0 && <p className="text-sm text-muted-foreground">No fields yet. Add one below.</p>}
            <ol className="space-y-2">
              {fields.map((f, i) => {
                const issue = byIndex.get(i);
                return (
                  <li
                    key={f.id}
                    className={`flex items-center gap-2 rounded-lg border p-2 ${selected === f.id ? "border-primary bg-primary/5" : ""}`}
                  >
                    <div className="flex flex-col">
                      <Button type="button" size="icon-xs" variant="ghost" disabled={archived || i === 0} aria-label={`Move ${f.label} up`} onClick={() => move(i, i - 1)}>
                        <ArrowUp />
                      </Button>
                      <Button type="button" size="icon-xs" variant="ghost" disabled={archived || i === fields.length - 1} aria-label={`Move ${f.label} down`} onClick={() => move(i, i + 1)}>
                        <ArrowDown />
                      </Button>
                    </div>
                    <button
                      type="button"
                      className="min-w-0 flex-1 rounded px-1 py-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      aria-pressed={selected === f.id}
                      onClick={() => setSelected(selected === f.id ? null : f.id)}
                    >
                      <span className="block truncate text-sm font-medium">
                        {i + 1}. {f.label || "(no label)"}
                        {f.required && <span aria-label="required"> *</span>}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {FIELD_TYPE_LABELS[f.type]}
                        {f.sensitive && " · sensitive"}
                        {f.mapsTo && ` · fills ${f.mapsTo}`}
                        {f.showIf && " · conditional"}
                      </span>
                      {issue && <span className="block text-xs text-destructive">{issue}</span>}
                    </button>
                    <Button type="button" size="icon-sm" variant="ghost" disabled={archived} aria-label={`Remove ${f.label}`} onClick={() => remove(f.id)}>
                      <Trash2 />
                    </Button>
                  </li>
                );
              })}
            </ol>
            {!archived && (
              <div className="flex flex-wrap items-end gap-2 pt-2">
                <Field id="add-type" label="Add a field">
                  <NativeSelect id="add-type" value={addType} onChange={(e) => setAddType(e.target.value as FieldType)}>
                    {fieldTypesFor(form.audience).map((t) => (
                      <option key={t} value={t}>
                        {FIELD_TYPE_LABELS[t]}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Button type="button" onClick={add} disabled={fields.length >= 60}>
                  <Plus aria-hidden /> Add
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{selectedField ? `Edit: ${selectedField.label || "field"}` : "Field settings"}</CardTitle>
          </CardHeader>
          <CardContent>
            {selectedField && !archived ? (
              <FieldEditor
                key={selectedField.id}
                field={selectedField}
                audience={form.audience}
                earlier={fields.slice(0, selectedIndex)}
                onChange={update}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Select a field to change its label, rules, mapping and retention.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <FormPreview fields={previewFields} faceCaptureEnabled={form.faceCaptureEnabled} />

      <Card>
        <CardHeader>
          <CardTitle>Publish</CardTitle>
          <CardDescription>
            Publishing creates a new version. Earlier versions never change, and every visit keeps the version it was answered with.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(problems.length > 0 || !parsed) && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-destructive" aria-label="Problems to fix before publishing">
              {!parsed && <li>Some fields have errors (marked in the list).</li>}
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={archived || busy || !unsaved}
              onClick={async () => {
                setBusy(true);
                if (await save()) toast.success("Draft saved");
                setBusy(false);
              }}
            >
              Save draft
            </Button>
            <Button
              disabled={archived || busy || !parsed || problems.length > 0}
              onClick={() =>
                run(async () => {
                  if (unsaved && !(await save())) return;
                  await publish({ organizationId, formId: form._id });
                }, "Published")
              }
            >
              Publish
            </Button>
            {!archived && (
              <Button variant="destructive" disabled={busy} onClick={() => run(() => archive({ organizationId, formId: form._id }), "Form archived")}>
                Archive
              </Button>
            )}
          </div>
          {unsaved && <p className="text-xs text-muted-foreground">You have unsaved changes.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Version history</CardTitle>
          <CardDescription>Published versions are read-only.</CardDescription>
        </CardHeader>
        <CardContent>
          {form.history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not published yet.</p>
          ) : (
            <ul className="divide-y">
              {form.history.map((h) => (
                <li key={h._id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span>
                    <span className="font-medium">Version {h.version}</span>
                    {h._id === form.publishedVersionId && <Badge className="ml-2">Live</Badge>}
                    <span className="block text-xs text-muted-foreground">
                      {new Date(h.publishedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} by {h.publishedByName} · {h.fieldCount} fields
                    </span>
                  </span>
                  <Link href={`/app/forms/${form._id}/versions/${h._id}`} className="text-primary underline-offset-4 hover:underline">
                    View
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
