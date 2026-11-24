import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { reportTitle, type IssueKind, type ModelRoom, type ModelSourceIssue, type ReportModel } from "@phc/domain";
import type { ReactNode } from "react";
import { COLORS } from "./tokens";
import { formatRaised, formatStamp, safeText } from "./format";
import { Cover, Footer, s } from "./shared";

export interface ReportDocumentProps {
  jobName: string; preparedFor: string | null; siteAddress: string | null; builtAt: string; timezone: string; logo: Buffer;
  model: ReportModel;
  /** Prepared (already resized) image bytes by photo id; null when the photo could not be loaded. */
  photos: Record<string, Buffer | null>;
}

const KIND_BADGE: Record<IssueKind, string> = { pre_install_correction: "PRE-INSTALL CORRECTION", punch_item: "PUNCH ITEM", missing_part: "MISSING PART", damaged_part: "DAMAGED PART", touch_up: "TOUCH-UP" };
const KIND_PLURAL: Record<IssueKind, string> = { pre_install_correction: "Pre-Install Corrections", punch_item: "Punch Items", missing_part: "Missing Parts", damaged_part: "Damaged Parts", touch_up: "Touch-Ups" };

const a = StyleSheet.create({
  roomHeading: { fontSize: 18, fontWeight: 600, marginBottom: 4 },
  divider: { height: 2, backgroundColor: COLORS.gold, marginTop: 18, marginBottom: 14 },
  statusRow: { flexDirection: "row", alignItems: "center", marginBottom: 6 },
  statusChip: { borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2, fontSize: 8, fontWeight: 600, marginRight: 8 },
  statusDone: { backgroundColor: COLORS.tint, borderWidth: 0.5, borderColor: COLORS.gold, color: COLORS.gold },
  statusNot: { backgroundColor: COLORS.ink, color: "#ffffff" },
  muted: { fontSize: 9, color: COLORS.muted },
  bullet: { fontSize: 10, lineHeight: 1.4, marginLeft: 8, marginBottom: 1 },
  issue: { marginBottom: 14, marginTop: 6 },
  badgeRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", marginBottom: 3 },
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
  shows: { fontSize: 9, color: COLORS.muted, marginTop: 22 },
});

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function IssueBlock({ issue, photos, tz, showKind, lead }: { issue: ModelSourceIssue; photos: ReportDocumentProps["photos"]; tz: string; showKind: boolean; lead?: ReactNode }) {
  const body = safeText(issue.description) || safeText(issue.title);
  return (
    <View style={a.issue} wrap={issue.photos.length > 4}>
      {lead}
      <View style={a.badgeRow}>
        {showKind ? <Text style={a.badge}>{KIND_BADGE[issue.kind]}</Text> : null}
        {issue.tradeName ? <Text style={a.badge}>{safeText(issue.tradeName).toUpperCase()}</Text> : null}
        <Text style={a.raised}>{formatRaised(safeText(issue.raisedByInitials), issue.raisedOn, tz)}</Text>
      </View>
      {issue.status === "completed" && issue.completedOn ? <Text style={a.raised}>{`Completed ${formatRaised("", issue.completedOn, tz).replace("Raised by: ", "").trim()}`}</Text> : null}
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

function RoomHead({ room, first, tz }: { room: ModelRoom; first: boolean; tz: string }) {
  const c = room.checklist;
  return (
    <View>
      {!first ? <View style={a.divider} /> : null}
      <Text style={a.roomHeading}>{safeText(room.roomName)}</Text>
      {c ? (
        <View style={a.statusRow}>
          <Text style={[a.statusChip, c.completed ? a.statusDone : a.statusNot]}>{c.completed ? "Completed" : "Not completed"}</Text>
          {c.byWho && c.at ? <Text style={a.muted}>{formatRaised(safeText(c.byWho), c.at, tz).replace("Raised by:", "Last checked by")}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

export function ReportDocument({ jobName, preparedFor, siteAddress, builtAt, timezone, model, logo, photos }: ReportDocumentProps) {
  const o = model.options; const t = model.totals;
  const showKind = o.kinds.length > 1 || (o.kinds.length === 1 && o.kinds[0] !== "pre_install_correction");
  const issueWord = (n: number) => (n === 1 ? "Issue" : "Issues");
  const shows = [
    o.kinds.length > 0 ? `${o.kinds.map((k) => KIND_PLURAL[k]).join(", ")} (${o.issueStatus === "both" ? "open and completed" : o.issueStatus})` : null,
    o.checklist === "all" ? "room status for every room" : o.checklist === "incomplete" ? "rooms not yet completed" : null,
    o.photos === "none" ? "no photos" : o.photos === "annotated" ? "marked-up photos" : "original photos",
  ].filter(Boolean).join(" · ");
  const empty = model.rooms.length === 0;
  return (
    <Document title={`${safeText(jobName)} – ${reportTitle(o)}`} author="Public House Creative">
      <Page size="LETTER" style={s.page}>
        <Cover {...{ jobName, preparedFor, siteAddress, builtAt, timezone, logo }} title={reportTitle(o)}>
          {o.kinds.length > 0 ? <Text style={s.count}>{t.identified} {issueWord(t.identified)} Identified</Text> : null}
          {o.kinds.length > 0 ? <Text style={[s.count, { marginTop: 4 }]}>{t.incomplete} {issueWord(t.incomplete)} Incomplete</Text> : null}
          {o.checklist === "all" ? <Text style={[s.count, { marginTop: 4 }]}>{t.roomsCompleted} of {plural(t.roomsWithChecklist, "Room", "Rooms")} Completed</Text> : null}
          {o.checklist === "incomplete" ? <Text style={[s.count, { marginTop: 4 }]}>{plural(t.roomsWithChecklist, "Room", "Rooms")} Not Completed</Text> : null}
          {empty ? <Text style={a.none}>{o.preset === "builder_site_audit" ? "No Pre-Install Corrections" : "Nothing to report for the options chosen"}</Text> : null}
          <Text style={a.shows}>Shows: {shows}</Text>
        </Cover>
        <Footer />
      </Page>
      {!empty ? (
        <Page size="LETTER" style={s.page}>
          {model.rooms.map((room, ri) => (
            <View key={room.roomId}>
              {room.issues.length === 0 ? (
                <View wrap={false}>
                  <RoomHead room={room} first={ri === 0} tz={timezone} />
                  {room.checklist && !room.checklist.completed ? room.checklist.outstanding.map((x) => <Text key={x} style={a.bullet}>{`• ${safeText(x)}`}</Text>) : null}
                  {room.checklist === null ? <Text style={a.muted}>Nothing to list</Text> : null}
                </View>
              ) : null}
              {room.issues.length > 0 ? (
                <View>
                  <View wrap={false}>
                    <RoomHead room={room} first={ri === 0} tz={timezone} />
                    {room.checklist && !room.checklist.completed ? room.checklist.outstanding.map((x) => <Text key={x} style={a.bullet}>{`• ${safeText(x)}`}</Text>) : null}
                  </View>
                  {room.issues.map((i) => <IssueBlock key={i.id} issue={i} photos={photos} tz={timezone} showKind={showKind} />)}
                </View>
              ) : null}
            </View>
          ))}
          <Footer />
        </Page>
      ) : null}
    </Document>
  );
}
