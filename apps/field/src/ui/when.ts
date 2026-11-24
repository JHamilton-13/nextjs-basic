/** "Nov 8, 2026, 2:32 PM" in the user's own locale and time zone. */
export const fmtWhen = (iso: string | undefined): string =>
  iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "time unknown";
