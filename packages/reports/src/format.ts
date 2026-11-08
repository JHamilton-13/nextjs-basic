function parts(iso: string, tz: string, opts: Intl.DateTimeFormatOptions): Record<string, string> | null {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return null;
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", ...opts }).formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** "11:43 9/10/26": 24-hour, unpadded hour, M/D/YY, in the report's time zone. */
export function formatStamp(iso: string, tz: string): string {
  const p = parts(iso, tz, { hour: "numeric", minute: "2-digit", month: "numeric", day: "numeric", year: "2-digit" });
  return p ? `${Number(p.hour)}:${p.minute} ${p.month}/${p.day}/${p.year}` : "time unknown";
}

export function formatCoverDate(iso: string, tz: string): string {
  const p = parts(iso, tz, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  return p ? `${p.weekday}, ${p.month} ${p.day}, ${p.year}` : "";
}

export function formatRaised(initials: string, iso: string, tz: string): string {
  const p = parts(iso, tz, { month: "numeric", day: "numeric" });
  return p ? `Raised by: ${initials} ${p.month}/${p.day}` : `Raised by: ${initials}`;
}

/** Removes what the report font cannot draw (emoji, joiners, control characters); never throws. */
export function safeText(s: string): string {
  return s
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍︎️⃣]/gu, " ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}
