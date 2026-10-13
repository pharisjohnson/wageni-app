import type { Doc } from "../_generated/dataModel";
import type { FieldType } from "../../lib/validation/forms";

/**
 * Approval policy for appointments and invitations. A site override wins over
 * the organization setting; the default is "approval required" (the behaviour
 * before this setting existed).
 */
export function requireApproval(org: Doc<"organizations">, site: Doc<"sites">): boolean {
  return site.requireApproval ?? org.policies?.requireApproval ?? true;
}

/** Face photos are collected only when an admin switched this on. Off by default. */
export function faceCaptureEnabled(org: Doc<"organizations">): boolean {
  return org.policies?.faceCaptureEnabled === true;
}

/** Field types the organization has switched off; never shown or required. */
export function disabledFieldTypes(org: Doc<"organizations">): FieldType[] {
  return faceCaptureEnabled(org) ? [] : ["face_photo"];
}
