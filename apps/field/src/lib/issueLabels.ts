import type { IssueCategory, IssueKind } from "@phc/domain";

export const CATEGORY_LABEL: Record<IssueCategory, string> = { pre_install_corrections: "Pre-Install Corrections", service: "Service", touch_ups: "Touch-ups" };
export const CATEGORY_HELP: Record<IssueCategory, string> = {
  pre_install_corrections: "Something the builder needs to fix before we install.",
  service: "Punch items, missing parts and damaged parts.",
  touch_ups: "Small finishing fixes.",
};
export const CATEGORY_ORDER: IssueCategory[] = ["pre_install_corrections", "service", "touch_ups"];
export const KIND_LABEL: Record<IssueKind, string> = { pre_install_correction: "Pre-Install", punch_item: "Punch Item", missing_part: "Missing part", damaged_part: "Damaged part", touch_up: "Touch Up" };
export const KIND_ORDER: IssueKind[] = ["pre_install_correction", "punch_item", "missing_part", "damaged_part", "touch_up"];

/** Plain words for a server refusal (the Sync queue and the issue card show these). */
export function reasonText(raw: string | undefined): string {
  const m = raw ?? "";
  if (/trade_required/.test(m)) return "This needs a trade. Edit the issue and choose one.";
  if (/trade_inactive/.test(m)) return "That trade is no longer used. Edit the issue and choose another.";
  if (/trade_not_found/.test(m)) return "That trade was not found. Edit the issue and choose another.";
  if (/trade_not_allowed/.test(m)) return "Only a Pre-Install Correction has a trade.";
  if (/photo_required/.test(m)) return "A damaged part needs a photo before it can be completed. Add one, then complete it again.";
  if (/issue_void/.test(m)) return "This issue was voided.";
  if (/issue_completed/.test(m)) return "This issue was already completed. Reopen it to change it.";
  if (/already_completed/.test(m)) return "This issue was already completed.";
  if (/not_completed/.test(m)) return "This issue is not completed.";
  if (/insufficient privilege/.test(m)) return "Only the person who raised this issue, or a manager, can change it.";
  return m || "The server did not accept this change.";
}
