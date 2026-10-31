"use client";

import { useCallback, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { api, ApiError, errorMessage } from "./api";
import { shortAddress } from "./format";
import { connectFreighter, FREIGHTER_MESSAGES, FreighterError, signTransactionWithFreighter } from "./freighter";
import type { Batch, Run, SignableBatch } from "./types";

export type PayPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "preparing" }
  | { kind: "signing"; batch: SignableBatch }
  | { kind: "submitting"; batch: SignableBatch }
  /** Stellar hasn't answered yet; the worker will settle it. */
  | { kind: "confirming"; batch: Batch }
  /** An unsigned batch's window has passed by our clock; Stellar has to confirm it can't land before a new one is built. */
  | { kind: "expiring"; batch: Batch }
  | { kind: "done" }
  | { kind: "error"; message: string };

function message(err: unknown): string {
  if (err instanceof FreighterError) return err.message || FREIGHTER_MESSAGES[err.code];
  if (err instanceof ApiError) return errorMessage(err);
  if (err instanceof Error) return err.message;
  return "Something went wrong. Nothing more was sent. Try again.";
}

/**
 * Pays a run: starts it if it's a draft, then for each transaction asks Freighter to sign with the
 * funding wallet and hands the signed transaction to OrgPay, until nothing is left to sign.
 * Every step is safe to repeat: OrgPay returns the same open batch until it is settled.
 */
export function usePayRun(run: Run) {
  const { mutate } = useSWRConfig();
  const [phase, setPhase] = useState<PayPhase>({ kind: "idle" });
  const running = useRef(false);
  const key = `/v1/payroll-runs/${run.id}`;

  const refresh = useCallback(
    async (next?: Run) => {
      if (next) await mutate(key, { run: next }, { revalidate: false });
      else await mutate(key);
      void mutate("/v1/summary");
    },
    [key, mutate],
  );

  const pay = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      // Make sure Freighter is ready (and on the right account) before anything changes.
      const active = await connectFreighter();
      if (active !== run.wallet.address) {
        throw new FreighterError(
          "WRONG_ACCOUNT",
          `Freighter is on ${shortAddress(active)}. Switch it to the funding wallet ${shortAddress(run.wallet.address)}, then try again.`,
        );
      }
      if (run.status === "DRAFT") {
        setPhase({ kind: "starting" });
        await refresh((await api.post<{ run: Run }>(`/v1/payroll-runs/${run.id}/start`)).run);
      }
      // One transaction per payment by default, so a run can need as many signatures as it has employees.
      for (let i = 0; i < 1000; i++) {
        setPhase({ kind: "preparing" });
        const next = await api.post<{ transaction: SignableBatch | null; run: Run }>(`/v1/payroll-runs/${run.id}/transactions/next`);
        await refresh(next.run);
        if (!next.transaction) {
          const submitted = next.run.transactions.find((b) => b.status === "SUBMITTED");
          const unsigned = next.run.transactions.find((b) => b.status === "AWAITING_SIGNATURE");
          setPhase(submitted ? { kind: "confirming", batch: submitted } : unsigned ? { kind: "expiring", batch: unsigned } : { kind: "done" });
          return;
        }
        const batch = next.transaction;
        setPhase({ kind: "signing", batch });
        const signedXdr = await signTransactionWithFreighter(batch.xdr, run.wallet.address);
        setPhase({ kind: "submitting", batch });
        let res: { transaction: Batch; run: Run };
        try {
          res = await api.post<{ transaction: Batch; run: Run }>(`/v1/payroll-runs/${run.id}/transactions/${batch.id}/submit`, { signedXdr });
        } catch (err) {
          // The signed batch may already be on its way: never suggest it wasn't sent.
          if (err instanceof ApiError && err.code !== "NETWORK" && err.status < 500) throw err;
          throw new Error(`We couldn't hear back after sending transaction ${batch.number}. It may have gone through: this page is checking with Stellar and will update by itself. Don't sign anything else until it does.`, { cause: err });
        }
        await refresh(res.run);
        if (res.transaction.status === "SUBMITTED") {
          setPhase({ kind: "confirming", batch: res.transaction });
          return;
        }
      }
      setPhase({ kind: "done" });
    } catch (err) {
      setPhase({ kind: "error", message: message(err) });
      void refresh();
    } finally {
      running.current = false;
    }
  }, [refresh, run.id, run.status, run.wallet.address]);

  const busy = phase.kind === "starting" || phase.kind === "preparing" || phase.kind === "signing" || phase.kind === "submitting";
  const reset = useCallback(() => setPhase({ kind: "idle" }), []);
  return { phase, pay, busy, reset };
}
