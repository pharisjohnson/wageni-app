/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as appointments from "../appointments.js";
import type * as audit from "../audit.js";
import type * as dashboard from "../dashboard.js";
import type * as gates from "../gates.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_functions from "../lib/functions.js";
import type * as lib_validate from "../lib/validate.js";
import type * as lib_visitors from "../lib/visitors.js";
import type * as memberships from "../memberships.js";
import type * as organizations from "../organizations.js";
import type * as platform from "../platform.js";
import type * as seed from "../seed.js";
import type * as sites from "../sites.js";
import type * as users from "../users.js";
import type * as validators from "../validators.js";
import type * as visits from "../visits.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  appointments: typeof appointments;
  audit: typeof audit;
  dashboard: typeof dashboard;
  gates: typeof gates;
  "lib/audit": typeof lib_audit;
  "lib/auth": typeof lib_auth;
  "lib/errors": typeof lib_errors;
  "lib/functions": typeof lib_functions;
  "lib/validate": typeof lib_validate;
  "lib/visitors": typeof lib_visitors;
  memberships: typeof memberships;
  organizations: typeof organizations;
  platform: typeof platform;
  seed: typeof seed;
  sites: typeof sites;
  users: typeof users;
  validators: typeof validators;
  visits: typeof visits;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
