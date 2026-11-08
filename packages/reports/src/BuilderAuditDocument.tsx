import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { BuilderAuditSummary, ReportIssue } from "@phc/domain";
import type { ReactNode } from "react";
import { COLORS } from "./tokens";
import { formatRaised, formatStamp, safeText } from "./format";
import { Cover, Footer, s } from "./shared";

export interface BuilderAuditProps {
  jobName: string; preparedFor: string | null; siteAddress: string | null; builtAt: string; timezone: string;
  summary: BuilderAuditSummary; logo: Buffer;
  /** Prepared (already resized) image bytes by photo id; null when the photo could not be loaded. */
  photos: Record<string, Buffer | null>;
}

const a = StyleSheet.create({
  roomHeading: { fontSize: 18, fontWeight: 600, marginBottom: 6 },
  divider: { height: 2, backgroundColor: COLORS.gold, marginTop: 18, marginBottom: 14 },
  issue: { marginBottom: 14 },
  badgeRow: { flexDirection: "row", alignItems: "center", marginBottom: 3 },
  badge: { backgroundColor: COLORS.tint, borderWidth: 0.5, borderColor: COLORS.divider, borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2, fontSize: 8, fontWeight: 600, marginRight: 8 },
  raised: { fontSize: 9, color: COLORS.muted },
  desc: { fontSize: 11, lineHeight: 1.4, marginTop: 2 },
  photos: { flexDirection: "row", flexWrap: "wrap", marginTop: 8 },
  photoCell: { width: "48.5%", height: 175, marginRight: "1.5%", marginBottom: 8, backgroundColor: COLORS.tint, position: "relative" },
  photoImg: { width: "100%", height: "100%", objectFit: "contain" },
  num: { position: "absolute", top: 4, right: 4, backgroundColor: COLORS.ink, color: "#ffffff", fontSize: 8, fontWeight: 600, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 8 },
  stamp: { position: "absolute", bottom: 4, right: 4, backgroundColor: "#000000", color: "#ffffff", fontSize: 7, paddingHorizontal: 4, paddingVertical: 1.5 },
  missing: { alignItems: "center", justifyContent: "center" },
  none: { fontSize: 12, color: COLORS.muted, marginTop: 30 },
});

function IssueBlock({ issue, photos, tz, lead }: { issue: ReportIssue; photos: BuilderAuditProps["photos"]; tz: string; lead?: ReactNode }) {
  const body = safeText(issue.description) || safeText(issue.title);
  return (
    <View style={a.issue} wrap={issue.photos.length > 4}>
      {lead}
      <View style={a.badgeRow}>
        {issue.tradeName ? <Text style={a.badge}>{safeText(issue.tradeName).toUpperCase()}</Text> : null}
        <Text style={a.raised}>{formatRaised(safeText(issue.raisedByInitials), issue.raisedOn, tz)}</Text>
      </View>
      <Text style={a.desc}>{body}</Text>
      {issue.photos.length > 0 ? (
        <View style={a.photos}>
          {issue.photos.map((p, i) => {
            const bytes = photos[p.id] ?? null;
            return (
              <View key={p.id} wrap={false} style={[a.photoCell, bytes ? {} : a.missing]}>
                {bytes ? <Image src={bytes} style={a.photoImg} /> : <Text style={s.muted}>Photo unavailable</Text>}
                <Text style={a.num}>{i + 1}</Text>
                <Text style={a.stamp}>{formatStamp(p.capturedAt, tz)}</Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

export function BuilderAuditDocument({ jobName, preparedFor, siteAddress, builtAt, timezone, summary, logo, photos }: BuilderAuditProps) {
  const n = summary.identified;
  return (
    <Document title={`${safeText(jobName)} – Builder Site Audit`} author="Public House Creative">
      <Page size="LETTER" style={s.page}>
        <Cover {...{ jobName, preparedFor, siteAddress, builtAt, timezone, logo }}>
          <Text style={s.count}>{n} {n === 1 ? "Issue" : "Issues"} Identified</Text>
          <Text style={[s.count, { marginTop: 4 }]}>{summary.incomplete} {summary.incomplete === 1 ? "Issue" : "Issues"} Incomplete</Text>
          {n === 0 ? <Text style={a.none}>No Pre-Install Corrections</Text> : null}
        </Cover>
        <Footer />
      </Page>
      {n > 0 ? (
        <Page size="LETTER" style={s.page}>
          {summary.rooms.map((room, ri) => (
            <View key={room.roomId}>
              {room.issues.map((i, k) => (
                <IssueBlock key={i.id} issue={i} photos={photos} tz={timezone}
                  lead={k === 0 ? <View>{ri > 0 ? <View style={a.divider} /> : null}<Text style={a.roomHeading}>{safeText(room.roomName)}</Text></View> : undefined} />
              ))}
            </View>
          ))}
          <Footer />
        </Page>
      ) : null}
    </Document>
  );
}
