/**
 * A deliberately strict check for the address a report is sent to (no spaces, no line breaks, exactly one @, a dotted domain).
 * It does not trim: the caller decides what to do with stray spaces, and a header-injection attempt ("a@b.com\nBcc: ...") is rejected.
 */
export function isValidEmail(s: string): boolean {
  if (typeof s !== "string" || s.length === 0 || s.length > 254) return false;
  if (/[\s,;<>()[\]\\"]/.test(s)) return false;
  const at = s.indexOf("@");
  if (at <= 0 || at !== s.lastIndexOf("@")) return false;
  const local = s.slice(0, at); const domain = s.slice(at + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((l) => l.length > 0 && l.length <= 63 && /^[A-Za-z0-9-]+$/.test(l) && !l.startsWith("-") && !l.endsWith("-"))) return false;
  return /^[A-Za-z]{2,}$/.test(labels[labels.length - 1]!);
}
