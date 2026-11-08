/**
 * Room spec fields the installer can see (read-only reference, useful when a part has to be remade). Names and labels follow
 * the Cockpit room editor so the two read the same. PHC-only fields are never listed here and the database refuses to store them.
 */
export interface RoomField { key: string; label: string }

/** Shown on the room card itself, in this order. */
export const CARD_FIELDS: RoomField[] = [
  { key: "panelName", label: "Panel Name" },
  { key: "woodSpecies", label: "Wood Species" },
  { key: "finishName", label: "Finish Name" },
  { key: "edgebanding", label: "Edgebanding" },
];

/** Everything else, shown under "More details". */
export const MORE_FIELDS: RoomField[] = [
  { key: "cabinetStyle", label: "Cabinet Style" },
  { key: "doorStyle", label: "Panel Construction" },
  { key: "finish", label: "Finish Type" },
  { key: "topOfCrownHeight", label: "Top of Crown Height" },
  { key: "ceilingSoffitHeight", label: "Ceiling/Soffit Height" },
  { key: "lightRail", label: "Light Rail Option" },
  { key: "ledLightTrack", label: "LED Routed Light Track" },
  { key: "plugMolding", label: "Routed Plug Molding" },
  { key: "finishedEndsPanels", label: "Finished Ends/Panels" },
  { key: "appliancePanels", label: "Appliance Panels?" },
  { key: "pullHardware", label: "Pull Hardware Type" },
  { key: "crownProfile", label: "Crown Profile" },
  { key: "toeKickStyle", label: "Toe Kick Style" },
  { key: "bottomTrimProfile", label: "Bottom Trim Profile" },
  { key: "drawerBox", label: "Drawer Box Material" },
  { key: "installOnFinishedFlooring", label: "Install on finished flooring?" },
  { key: "flooringSubstrateThickness", label: "Flooring with Substrate Thickness" },
  { key: "wallCeilingStonePanels", label: "Wall or Ceiling Stone or Panels?" },
  { key: "woodTops", label: "Wood Tops?" },
  { key: "counterThickness", label: "Counter Thickness" },
  { key: "apronSinkScribe", label: "Apron Sink Scribe?" },
  { key: "topOfSinkHeight", label: "Top Of Sink Height" },
  { key: "sheen", label: "Sheen" },
  { key: "finishTone", label: "Finish Tone" },
  { key: "finishFeature", label: "Finish Feature" },
  { key: "finishSampleId", label: "Finish Sample ID" },
  { key: "additionalNotes", label: "Additional Notes" },
];

/** Never shown to installers (mirrors the database guard app.room_details_valid). */
export const HIDDEN_KEYS = new Set(["phcOnlyNotes", "gateCode"]);

export const hasTBD = (v: string | undefined | null): boolean => (v ?? "").toUpperCase().includes("TBD");

/** The fields of a room that have a value, as label/value pairs, never including hidden keys. */
export function fieldsFor(details: Record<string, string> | undefined, list: RoomField[]): { key: string; label: string; value: string }[] {
  const d = details ?? {};
  return list.filter((f) => !HIDDEN_KEYS.has(f.key) && typeof d[f.key] === "string" && d[f.key]!.trim() !== "").map((f) => ({ ...f, value: d[f.key]!.trim() }));
}
