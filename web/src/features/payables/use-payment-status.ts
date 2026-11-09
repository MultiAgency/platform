import { isSettled } from "./payment-status";
import { queries } from "../../shared/queries";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { client } from "../../shared/client";

export function usePaymentStatus(id: string | undefined) {
  // The first read answers at once; each later one waits at the provider until the payment moves (up to
  // 25 s) and is asked again as soon as it answers: news arrives at once, in about 2 calls a minute. The
  // provider holds at most 10 waits per API key and answers the rest at once, so a wait that came back
  // quickly without the payment finishing is followed by a 4 s pause instead of an immediate retry.
  const observation = useMemo(() => ({ seen: false, quick: false }), [id]);
  const status = useQuery({
    ...queries.paymentStatus(id),
    retry: false,
    enabled: Boolean(id),
    queryFn: async ({ signal }) => {
      const waited = observation.seen;
      const started = Date.now();
      const result = await client.paymentStatus({ correlationId: id!, ...(waited && { waitMs: 25_000 }) }, { signal });
      observation.quick = waited && Date.now() - started < 5_000;
      observation.seen = true;
      return result;
    },
    refetchInterval: (q) => (q.state.error ? false : q.state.data && isSettled(q.state.data.status) ? false : observation.quick ? 4_000 : 500),
  });
  return status;
}
