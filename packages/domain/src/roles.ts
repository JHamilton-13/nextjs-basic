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
 * Roles allowed to release a project for installation once an audit is clear or overridden.
 * Managers only (owner decision 2026-11-08). Configurable through ReadinessPolicy.releaseRoles.
 */
export const DEFAULT_RELEASE_ROLES: readonly Role[] = [...OVERRIDE_ROLES];

export const isOverrideRole = (role: string): role is Role => (OVERRIDE_ROLES as readonly string[]).includes(role);

export const isValidTimestamp = (s: unknown): s is string => typeof s === "string" && s !== "" && !Number.isNaN(Date.parse(s));
