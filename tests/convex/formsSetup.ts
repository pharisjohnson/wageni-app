import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { registerUpload } from "../../convex/lib/files";
import { addMember, createOrgWithOwner, type T } from "./setup";

type Field = {
  id: string;
  type: string;
  label: string;
  required: boolean;
  sensitive: boolean;
  options?: string[];
  showIf?: { fieldId: string; equals: string };
  mapsTo?: string;
  consentText?: string;
  storeImage?: boolean;
  retentionDays?: number;
  idSource?: string;
};

export const CONSENT = "I agree that my photo and ID are processed for security.";

export function visitorFields(): Field[] {
  const base = { required: false, sensitive: false };
  return [
    { ...base, id: "name", type: "short_text", label: "Name", required: true, mapsTo: "visitor.name" },
    { ...base, id: "phone", type: "phone", label: "Phone", required: true, mapsTo: "visitor.phone" },
    { ...base, id: "company", type: "short_text", label: "Company", mapsTo: "visitor.company" },
    { ...base, id: "purpose", type: "short_text", label: "Purpose", required: true, mapsTo: "visit.purpose" },
    { ...base, id: "id_number", type: "short_text", label: "ID number", sensitive: true, mapsTo: "visitor.idNumber", idSource: "idNumber" },
    { ...base, id: "contact", type: "single_choice", label: "Contact by", options: ["Phone", "Email"] },
    { ...base, id: "email_detail", type: "email", label: "Email", required: true, showIf: { fieldId: "contact", equals: "Email" } },
    { ...base, id: "consent", type: "consent", label: "Consent", required: true, consentText: CONSENT },
    { ...base, id: "signature", type: "signature", label: "Signature", retentionDays: 30 },
    { ...base, id: "id_scan", type: "id_scan", label: "ID", sensitive: true, storeImage: true, retentionDays: 7 },
  ];
}

export const GOOD_ANSWERS = {
  name: "Jane Visitor",
  phone: "+254700111222",
  purpose: "Interview",
  consent: { accepted: true, text: CONSENT },
};

/** Org + site + gate + paired kiosk + host + receptionist, optionally with a published visitor form. */
export async function formsSetup(t: T, slug = "acme") {
  const org = await createOrgWithOwner(t, slug, slug);
  const host = await addMember(t, org.organizationId, `${slug}-hana`, "host");
  const reception = await addMember(t, org.organizationId, `${slug}-rita`, "receptionist");
  const admin = await addMember(t, org.organizationId, `${slug}-ada`, "admin");
  const gateId = await org.owner.as.mutation(api.gates.create, {
    organizationId: org.organizationId,
    siteId: org.siteId,
    name: "Front",
    type: "pedestrian",
  });
  const { token, deviceId } = await org.owner.as.mutation(api.kioskDevices.issue, {
    organizationId: org.organizationId,
    gateId,
    name: "Tablet",
  });
  const k = { slug, token };
  const orgArg = { organizationId: org.organizationId };

  async function createForm(fields: Field[] = visitorFields(), extra: { siteId?: Id<"sites">; name?: string } = {}) {
    return await org.owner.as.mutation(api.forms.create, {
      ...orgArg,
      name: extra.name ?? "Visitor registration",
      audience: "visitor",
      siteId: extra.siteId,
      fields: fields as never,
    });
  }
  async function publishedForm(fields?: Field[], extra?: { siteId?: Id<"sites">; name?: string }) {
    const formId = await createForm(fields, extra);
    const versionId = await org.owner.as.mutation(api.forms.publish, { ...orgArg, formId });
    return { formId, versionId };
  }
  async function activeForm() {
    return await t.query(api.kioskForms.activeVisitorForm, k);
  }
  /**
   * Store a blob and register it as the kiosk's `registerUploaded` would.
   * convex-test does not expose a stored blob's content type, so the type is
   * injected through `registerUpload`'s metadata reader.
   */
  async function upload(
    kind: "signature" | "id_scan" | "photo" | "file",
    type: string,
    bytes: number | Uint8Array = 100,
    opts: { verify?: boolean } = {},
  ) {
    const data = typeof bytes === "number" ? new Uint8Array(bytes) : bytes;
    const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob([data as unknown as BlobPart], { type })));
    const res = await t.run(async (ctx) =>
      registerUpload(
        ctx,
        {
          organizationId: org.organizationId,
          siteId: org.siteId,
          storageId,
          kind,
          uploader: { kioskDeviceId: deviceId },
          // Fake bytes would fail content verification, so it only runs when a test asks for it.
          verify: opts.verify ?? false,
        },
        async (c, id) => {
          const meta = await c.db.system.get(id);
          return meta ? { size: meta.size, contentType: type } : null;
        },
      ),
    );
    return { storageId, res };
  }
  return { ...org, host, reception, admin, gateId, token, deviceId, k, orgArg, createForm, publishedForm, activeForm, upload };
}

export type FormsSetup = Awaited<ReturnType<typeof formsSetup>>;
