/**
 * Offline data lives in the browser's storage, which a phone may clear when space is low or (Safari, in a normal tab)
 * after about a week unused. Asking for "persistent" storage and showing the numbers lets the installer see the risk.
 */
export interface StorageInfo { supported: boolean; persisted: boolean; usedBytes: number; quotaBytes: number; installed: boolean }

export const isInstalled = (): boolean =>
  (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches) || (navigator as unknown as { standalone?: boolean }).standalone === true;

export async function requestPersistence(): Promise<boolean> {
  try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}

export async function readStorage(): Promise<StorageInfo> {
  const s = navigator.storage;
  if (!s?.estimate) return { supported: false, persisted: false, usedBytes: 0, quotaBytes: 0, installed: isInstalled() };
  const [est, persisted] = await Promise.all([s.estimate(), s.persisted ? s.persisted().catch(() => false) : Promise.resolve(false)]);
  return { supported: true, persisted, usedBytes: est.usage ?? 0, quotaBytes: est.quota ?? 0, installed: isInstalled() };
}

export const fmtBytes = (n: number): string => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(0)} MB` : `${Math.max(0, Math.round(n / 1024))} KB`);

/** A plain-language warning, or null when all is well. */
export function storageWarning(i: StorageInfo): string | null {
  if (!i.supported) return "This browser does not report storage. Keep the app installed and sync often.";
  if (i.quotaBytes > 0 && i.usedBytes / i.quotaBytes > 0.8) return "Device storage for this app is almost full. Connect and sync now so photos can be cleared from the phone.";
  if (!i.persisted && !i.installed) return "Your phone may clear this app's offline data if it is not used for a while. Install the app (see below) and sync before you leave a site.";
  return null;
}
