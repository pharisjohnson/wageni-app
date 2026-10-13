/* eslint-disable */
  /**
   * Generated `api` utility.
   *
   * THIS CODE IS AUTOMATICALLY GENERATED.
   *
   * To regenerate, run `npx convex dev`.
   * @module
   */
  
  import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
  import type * as appointments from "../appointments.js";
import type * as attendance from "../attendance.js";
import type * as attendancePins from "../attendancePins.js";
import type * as audit from "../audit.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as files from "../files.js";
import type * as filesKiosk from "../filesKiosk.js";
import type * as filesVerify from "../filesVerify.js";
import type * as formRetention from "../formRetention.js";
import type * as forms from "../forms.js";
import type * as gates from "../gates.js";
import type * as http from "../http.js";
import type * as invitations from "../invitations.js";
import type * as kiosk from "../kiosk.js";
import type * as kioskAttendance from "../kioskAttendance.js";
import type * as kioskDevices from "../kioskDevices.js";
import type * as kioskForms from "../kioskForms.js";
import type * as kioskVisitor from "../kioskVisitor.js";
import type * as lib_attendance from "../lib/attendance.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_files from "../lib/files.js";
import type * as lib_formResponses from "../lib/formResponses.js";
import type * as lib_functions from "../lib/functions.js";
import type * as lib_invitationHooks from "../lib/invitationHooks.js";
import type * as lib_invitationToken from "../lib/invitationToken.js";
import type * as lib_kiosk from "../lib/kiosk.js";
import type * as lib_kioskLookup from "../lib/kioskLookup.js";
import type * as lib_notify from "../lib/notify.js";
import type * as lib_pin from "../lib/pin.js";
import type * as lib_policy from "../lib/policy.js";
import type * as lib_proxy from "../lib/proxy.js";
import type * as lib_publicLimit from "../lib/publicLimit.js";
import type * as lib_reportExport from "../lib/reportExport.js";
import type * as lib_reports from "../lib/reports.js";
import type * as lib_retentionCron from "../lib/retentionCron.js";
import type * as lib_time from "../lib/time.js";
import type * as lib_validate from "../lib/validate.js";
import type * as lib_visitors from "../lib/visitors.js";
import type * as lib_visits from "../lib/visits.js";
import type * as memberships from "../memberships.js";
import type * as notifications from "../notifications.js";
import type * as notificationsCron from "../notificationsCron.js";
import type * as notificationsDelivery from "../notificationsDelivery.js";
import type * as organizations from "../organizations.js";
import type * as platform from "../platform.js";
import type * as policies from "../policies.js";
import type * as publicLimits from "../publicLimits.js";
import type * as reports from "../reports.js";
import type * as reportsExport from "../reportsExport.js";
import type * as retention from "../retention.js";
import type * as seed from "../seed.js";
import type * as sites from "../sites.js";
import type * as users from "../users.js";
import type * as validators from "../validators.js";
import type * as visits from "../visits.js";

  /**
   * A utility for referencing Convex functions in your app's API.
   *
   * Usage:
   * ```js
   * const myFunctionReference = api.myModule.myFunction;
   * ```
   */
  declare const fullApi: ApiFromModules<{
    "appointments": typeof appointments,
"attendance": typeof attendance,
"attendancePins": typeof attendancePins,
"audit": typeof audit,
"crons": typeof crons,
"dashboard": typeof dashboard,
"files": typeof files,
"filesKiosk": typeof filesKiosk,
"filesVerify": typeof filesVerify,
"formRetention": typeof formRetention,
"forms": typeof forms,
"gates": typeof gates,
"http": typeof http,
"invitations": typeof invitations,
"kiosk": typeof kiosk,
"kioskAttendance": typeof kioskAttendance,
"kioskDevices": typeof kioskDevices,
"kioskForms": typeof kioskForms,
"kioskVisitor": typeof kioskVisitor,
"lib/attendance": typeof lib_attendance,
"lib/audit": typeof lib_audit,
"lib/auth": typeof lib_auth,
"lib/errors": typeof lib_errors,
"lib/files": typeof lib_files,
"lib/formResponses": typeof lib_formResponses,
"lib/functions": typeof lib_functions,
"lib/invitationHooks": typeof lib_invitationHooks,
"lib/invitationToken": typeof lib_invitationToken,
"lib/kiosk": typeof lib_kiosk,
"lib/kioskLookup": typeof lib_kioskLookup,
"lib/notify": typeof lib_notify,
"lib/pin": typeof lib_pin,
"lib/policy": typeof lib_policy,
"lib/proxy": typeof lib_proxy,
"lib/publicLimit": typeof lib_publicLimit,
"lib/reportExport": typeof lib_reportExport,
"lib/reports": typeof lib_reports,
"lib/retentionCron": typeof lib_retentionCron,
"lib/time": typeof lib_time,
"lib/validate": typeof lib_validate,
"lib/visitors": typeof lib_visitors,
"lib/visits": typeof lib_visits,
"memberships": typeof memberships,
"notifications": typeof notifications,
"notificationsCron": typeof notificationsCron,
"notificationsDelivery": typeof notificationsDelivery,
"organizations": typeof organizations,
"platform": typeof platform,
"policies": typeof policies,
"publicLimits": typeof publicLimits,
"reports": typeof reports,
"reportsExport": typeof reportsExport,
"retention": typeof retention,
"seed": typeof seed,
"sites": typeof sites,
"users": typeof users,
"validators": typeof validators,
"visits": typeof visits,
  }>;
  export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
  export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;
  