/** Issue kinds, exactly as the database enum public.issue_kind. */
export type IssueKind = "pre_install_correction" | "punch_item" | "touch_up" | "missing_part" | "damaged_part";
export type IssueCategory = "pre_install_corrections" | "service" | "touch_ups";

/** The installer picks a category first; the kind lives inside it. Existing issue rows need no rewrite (category is derived). */
export function categoryOf(kind: IssueKind): IssueCategory {
  switch (kind) {
    case "pre_install_correction": return "pre_install_corrections";
    case "punch_item":
    case "missing_part":
    case "damaged_part": return "service";
    case "touch_up": return "touch_ups";
  }
}

/** Only Pre Install Corrections carry a Trade (plumbing, electrical, ...). */
export const requiresTrade = (kind: IssueKind): boolean => kind === "pre_install_correction";
