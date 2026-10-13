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
import type * as dashboard from "../dashboard.js";
import type * as gates from "../gates.js";
import type * as kiosk from "../kiosk.js";
import type * as kioskAttendance from "../kioskAttendance.js";
import type * as kioskDevices from "../kioskDevices.js";
import type * as kioskVisitor from "../kioskVisitor.js";
import type * as lib_attendance from "../lib/attendance.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_functions from "../lib/functions.js";
import type * as lib_kiosk from "../lib/kiosk.js";
import type * as lib_kioskLookup from "../lib/kioskLookup.js";
import type * as lib_pin from "../lib/pin.js";
import type * as lib_time from "../lib/time.js";
import type * as lib_validate from "../lib/validate.js";
import type * as lib_visitors from "../lib/visitors.js";
import type * as lib_visits from "../lib/visits.js";
import type * as memberships from "../memberships.js";
import type * as organizations from "../organizations.js";
import type * as platform from "../platform.js";
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
"dashboard": typeof dashboard,
"gates": typeof gates,
"kiosk": typeof kiosk,
"kioskAttendance": typeof kioskAttendance,
"kioskDevices": typeof kioskDevices,
"kioskVisitor": typeof kioskVisitor,
"lib/attendance": typeof lib_attendance,
"lib/audit": typeof lib_audit,
"lib/auth": typeof lib_auth,
"lib/errors": typeof lib_errors,
"lib/functions": typeof lib_functions,
"lib/kiosk": typeof lib_kiosk,
"lib/kioskLookup": typeof lib_kioskLookup,
"lib/pin": typeof lib_pin,
"lib/time": typeof lib_time,
"lib/validate": typeof lib_validate,
"lib/visitors": typeof lib_visitors,
"lib/visits": typeof lib_visits,
"memberships": typeof memberships,
"organizations": typeof organizations,
"platform": typeof platform,
"seed": typeof seed,
"sites": typeof sites,
"users": typeof users,
"validators": typeof validators,
"visits": typeof visits,
  }>;
  export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
  export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;
  