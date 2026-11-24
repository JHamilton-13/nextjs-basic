import { useEffect, useState } from "react";

/** Re-reads from IndexedDB whenever the app's change counter ticks. */
export function useLive<T>(tick: number, load: () => Promise<T>, deps: unknown[] = []): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    let alive = true;
    void load().then((v) => { if (alive) setValue(v); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  return value;
}
