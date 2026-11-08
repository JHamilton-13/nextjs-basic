import { Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ReactNode } from "react";
import { COLORS, FONT_FAMILY } from "./tokens";
import { formatCoverDate, safeText } from "./format";

export const s = StyleSheet.create({
  page: { fontFamily: FONT_FAMILY, fontSize: 10, color: COLORS.ink, paddingTop: 48, paddingBottom: 56, paddingHorizontal: 48 },
  coverTop: { flexDirection: "row", justifyContent: "flex-end" },
  logoBox: { alignItems: "center" },
  logo: { width: 64, height: 64 },
  company: { fontSize: 9, color: COLORS.muted, marginTop: 4 },
  coverKind: { fontSize: 11, color: COLORS.gold, fontWeight: 600, marginTop: 80, letterSpacing: 1 },
  jobName: { fontSize: 30, fontWeight: 600, marginTop: 8 },
  rule: { height: 3, backgroundColor: COLORS.gold, marginTop: 14, marginBottom: 14 },
  coverLine: { fontSize: 13, marginTop: 4 },
  muted: { color: COLORS.muted },
  count: { fontSize: 18, fontWeight: 600, marginTop: 22 },
  footer: { position: "absolute", bottom: 24, left: 48, right: 48, textAlign: "right", fontSize: 8, color: COLORS.muted },
});

export function Footer() {
  return <Text style={s.footer} fixed render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />;
}

export interface CoverProps { title?: string; jobName: string; preparedFor: string | null; siteAddress: string | null; builtAt: string; timezone: string; logo: Buffer; children?: ReactNode }

/** Cover page body (inside a Page): logo top right, job name, gold rule, date, prepared for, address, then the caller's counts. */
export function Cover({ title, jobName, preparedFor, siteAddress, builtAt, timezone, logo, children }: CoverProps) {
  return (
    <View>
      <View style={s.coverTop}>
        <View style={s.logoBox}>
          <Image src={logo} style={s.logo} />
          <Text style={s.company}>Public House Creative</Text>
        </View>
      </View>
      {title ? <Text style={s.coverKind}>{title}</Text> : null}
      <Text style={s.jobName}>{safeText(jobName)}</Text>
      <View style={s.rule} />
      <Text style={s.coverLine}>{formatCoverDate(builtAt, timezone)}</Text>
      {preparedFor ? <Text style={s.coverLine}>Prepared For {safeText(preparedFor)}</Text> : null}
      {siteAddress ? <Text style={[s.coverLine, s.muted]}>{safeText(siteAddress)}</Text> : null}
      {children}
    </View>
  );
}

export { Page, Text, View, Image };
