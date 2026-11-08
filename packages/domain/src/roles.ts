export type Role =
  | "admin"
  | "production_manager"
  | "project_manager"
  | "installation_manager"
  | "installer"
  | "warehouse"
  | "shop"
  | "service_technician"
  | "general_contractor"
  | "client";

/** Roles allowed to grant overrides, record evidence exceptions, and give supervisor approval (spec §4.4). */
export const OVERRIDE_ROLES: readonly Role[] = ["admin", "production_manager", "project_manager", "installation_manager"];

/**
 * Default roles allowed to release a project for installation once an audit is clear or overridden.
 * Managers plus installers (an installer proceeds after a manager's documented override).
 * Configurable through ReadinessPolicy.releaseRoles. Flagged for owner confirmation in docs/MILESTONES.md.
 */
export const DEFAULT_RELEASE_ROLES: readonly Role[] = [...OVERRIDE_ROLES, "installer"];

export const isOverrideRole = (role: string): role is Role => (OVERRIDE_ROLES as readonly string[]).includes(role);

export const isValidTimestamp = (s: unknown): s is string => typeof s === "string" && s !== "" && !Number.isNaN(Date.parse(s));
