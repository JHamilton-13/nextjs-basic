import type { OperationResult } from "@phc/domain";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TransportError, type Transport } from "./outbox";

/** Sends operations through the apply_op RPC and classifies every failure as retryable or permanent. */
export function supabaseTransport(sb: SupabaseClient): Transport {
  return {
    async send(op) {
      let res;
      try {
        res = await sb.rpc("apply_op", { op });
      } catch (e) {
        throw new TransportError("network", e instanceof Error ? e.message : String(e), true);
      }
      const { data, error, status } = res;
      if (error) {
        const code = (error as { code?: string }).code ?? "";
        const msg = error.message || "Request failed";
        if (status === 0 || (!code && !status)) throw new TransportError("network", msg, true);
        if (status === 401 || code === "28000" || /jwt|not authenticated/i.test(msg)) throw new TransportError("auth", msg, true);
        if (status >= 500) throw new TransportError("server", msg, true);
        throw new TransportError("server", msg, false); // e.g. 42501 permission denied: retrying cannot help
      }
      return data as OperationResult;
    },
  };
}
