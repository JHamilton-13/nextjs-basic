/** The pre-install audit screens are hidden from installers (owner decision, 2026-11-08). Set VITE_SHOW_AUDIT=1 to show them (used by the test builds). */
export const SHOW_AUDIT = import.meta.env.VITE_SHOW_AUDIT === "1";
