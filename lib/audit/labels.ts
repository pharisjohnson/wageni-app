/** Human-readable labels for audit actions. Unknown actions fall back to a tidied version of the key. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "appointment.created": "Appointment created",
  "appointment.rescheduled": "Appointment rescheduled",
  "appointment.cancelled": "Appointment cancelled",
  "appointment.approved": "Appointment approved",
  "appointment.declined": "Appointment declined",
  "attendance.correction_requested_for": "Attendance correction requested for someone",
  "attendance.correction_approved": "Attendance correction approved",
  "attendance.correction_rejected": "Attendance correction rejected",
  "attendance.pin_locked": "Staff PIN locked",
  "attendance.pin_reset": "Staff PIN reset",
  "attendance.pin_set": "Staff PIN set",
  "attendance.recorded_on_behalf": "Attendance recorded on behalf of staff",
  "attendance.staff_number_set": "Staff number set",
  "gate.created": "Gate created",
  "gate.updated": "Gate updated",
  "kiosk.lookup_throttled": "Kiosk lookups throttled",
  "kiosk_device.issued": "Kiosk device paired",
  "kiosk_device.revoked": "Kiosk device revoked",
  "membership.overrides_changed": "Member permissions changed",
  "membership.role_changed": "Member role changed",
  "membership.site_access_changed": "Member site access changed",
  "membership.status_changed": "Member status changed",
  "organization.branding_updated": "Branding updated",
  "organization.created": "Organization created",
  "organization.demo_seeded": "Demo data loaded",
  "organization.retention_updated": "Retention settings changed",
  "platform.organization_status_changed": "Organization status changed by platform",
  "report.exported": "Report exported",
  "retention.purged": "Expired records purged",
  "site.created": "Site created",
  "site.updated": "Site updated",
  "visit.checked_in": "Visitor checked in",
  "visit.walk_in_registered": "Walk-in registered",
  "visit.checked_out": "Visitor checked out",
  "visit.host_checked_out": "Meeting ended by host",
};

export function auditActionLabel(action: string): string {
  const known = AUDIT_ACTION_LABELS[action];
  if (known) return known;
  const text = action.replace(/[._]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const AUDIT_RESOURCE_TYPES = [
  "appointment",
  "attendanceCorrection",
  "attendanceEvent",
  "gate",
  "kiosk_device",
  "membership",
  "organization",
  "report",
  "retention",
  "site",
  "visit",
] as const;

export function auditResourceLabel(type: string): string {
  const text = type.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
