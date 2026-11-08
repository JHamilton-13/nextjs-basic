import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { COLORS } from "./tokens";
import { formatStamp, safeText } from "./format";
import { Cover, Footer, s } from "./shared";

export interface RoomStatusRow { roomName: string; completed: boolean; byWho: string | null; at: string | null; outstanding: string[]; openIssues: number }
export interface RoomStatusProps { jobName: string; preparedFor: string | null; siteAddress: string | null; builtAt: string; timezone: string; logo: Buffer; rows: RoomStatusRow[] }

const t = StyleSheet.create({
  head: { flexDirection: "row", backgroundColor: COLORS.tint, paddingVertical: 6, paddingHorizontal: 6, fontWeight: 600 },
  row: { flexDirection: "row", paddingVertical: 6, paddingHorizontal: 6 },
  alt: { backgroundColor: COLORS.tint },
  c1: { width: "22%" }, c2: { width: "16%" }, c3: { width: "20%" }, c4: { width: "34%" }, c5: { width: "8%", textAlign: "right" },
  h: { fontSize: 9, fontWeight: 600, color: COLORS.muted },
  title: { fontSize: 18, fontWeight: 600, marginBottom: 10 },
});

export function RoomStatusDocument({ jobName, preparedFor, siteAddress, builtAt, timezone, logo, rows }: RoomStatusProps) {
  const done = rows.filter((r) => r.completed).length;
  return (
    <Document title={`${safeText(jobName)} – Room Status`} author="Public House Creative">
      <Page size="LETTER" style={s.page}>
        <Cover {...{ jobName, preparedFor, siteAddress, builtAt, timezone, logo }}>
          <Text style={s.count}>Room Status</Text>
          <Text style={[s.coverLine, { marginTop: 6 }]}>{done} of {rows.length} {rows.length === 1 ? "room" : "rooms"} completed</Text>
        </Cover>
        <Footer />
      </Page>
      <Page size="LETTER" style={s.page}>
        <Text style={t.title}>Rooms</Text>
        <View style={t.head} fixed>
          <Text style={[t.c1, t.h]}>Room</Text><Text style={[t.c2, t.h]}>Status</Text><Text style={[t.c3, t.h]}>Checked by / when</Text>
          <Text style={[t.c4, t.h]}>Not done</Text><Text style={[t.c5, t.h]}>Open</Text>
        </View>
        {rows.map((r, i) => (
          <View key={`${r.roomName}-${i}`} style={[t.row, i % 2 === 1 ? t.alt : {}]} wrap={false}>
            <Text style={t.c1}>{safeText(r.roomName)}</Text>
            <Text style={t.c2}>{r.completed ? "Completed" : "Not completed"}</Text>
            <Text style={t.c3}>{r.byWho ? `${safeText(r.byWho)}${r.at ? " " + formatStamp(r.at, timezone) : ""}` : "—"}</Text>
            <Text style={t.c4}>{r.outstanding.length ? safeText(r.outstanding.join("; ")) : "—"}</Text>
            <Text style={t.c5}>{r.openIssues}</Text>
          </View>
        ))}
        <Footer />
      </Page>
    </Document>
  );
}
