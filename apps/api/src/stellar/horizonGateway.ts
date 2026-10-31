import type { Trustline } from "@orgpay/shared";
import { AppError } from "../lib/errors";
import type { AccountState, LedgerInfo, StellarGateway, SubmitResult, TransactionLookup } from "./gateway";

interface HorizonBalance {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  balance?: string;
  limit?: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
}

interface HorizonAccount {
  sequence?: string;
  subentry_count?: number;
  num_sponsoring?: number;
  num_sponsored?: number;
  balances?: HorizonBalance[];
}

/** At most this many Horizon requests in flight from this process, whoever asked. */
const MAX_CONCURRENT = 12;

class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const unavailable = () =>
  new AppError("HORIZON_UNAVAILABLE", "Could not reach Stellar right now. Try again in a moment.", { retryAfter: 10 });

/** Stellar over Horizon. Every read has a timeout; submission waits longer (Horizon holds it ~30 s). */
export class HorizonGateway implements StellarGateway {
  private readonly base: string;
  private readonly slots = new Semaphore(MAX_CONCURRENT);

  constructor(
    horizonUrl: string,
    private readonly timeoutMs = 8000,
    private readonly submitTimeoutMs = 40_000,
  ) {
    this.base = horizonUrl.replace(/\/$/, "");
  }

  private async getJson<T>(path: string): Promise<{ status: number; body: T | null; nodeLedger: number | null }> {
    let res: Response;
    try {
      res = await this.slots.run(() =>
        fetch(`${this.base}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) }),
      );
    } catch {
      throw unavailable();
    }
    const header = res.headers.get("latest-ledger");
    const nodeLedger = header && /^\d+$/.test(header) ? Number.parseInt(header, 10) : null;
    if (res.status === 404) return { status: 404, body: null, nodeLedger };
    if (!res.ok) throw unavailable();
    try {
      return { status: res.status, body: (await res.json()) as T, nodeLedger };
    } catch {
      throw unavailable();
    }
  }

  async loadAccount(address: string): Promise<AccountState> {
    const { body } = await this.getJson<HorizonAccount>(`/accounts/${encodeURIComponent(address)}`);
    if (!body) return { exists: false };
    if (typeof body.sequence !== "string") throw unavailable();
    let nativeBalance = "0";
    let nativeSellingLiabilities = "0";
    const trustlines: Trustline[] = [];
    for (const b of body.balances ?? []) {
      if (b.asset_type === "native") {
        nativeBalance = b.balance ?? "0";
        nativeSellingLiabilities = b.selling_liabilities ?? "0";
        continue;
      }
      if (!b.asset_code || !b.asset_issuer) continue; // liquidity pool shares
      trustlines.push({
        code: b.asset_code,
        issuer: b.asset_issuer,
        limit: b.limit ?? "0",
        balance: b.balance ?? "0",
        buyingLiabilities: b.buying_liabilities ?? "0",
        sellingLiabilities: b.selling_liabilities ?? "0",
        // Only fully authorised trustlines can receive; "maintain liabilities" cannot.
        authorized: b.is_authorized === true,
      });
    }
    return {
      exists: true,
      sequence: body.sequence,
      nativeBalance,
      nativeSellingLiabilities,
      subentries: body.subentry_count ?? 0,
      sponsoring: body.num_sponsoring ?? 0,
      sponsored: body.num_sponsored ?? 0,
      trustlines,
    };
  }

  async latestLedger(): Promise<LedgerInfo> {
    const { body } = await this.getJson<{ _embedded?: { records?: { sequence?: number; closed_at?: string }[] } }>(
      "/ledgers?order=desc&limit=1",
    );
    const rec = body?._embedded?.records?.[0];
    if (!rec || typeof rec.sequence !== "number" || !rec.closed_at) throw unavailable();
    return { sequence: rec.sequence, closedAt: new Date(rec.closed_at) };
  }

  async getTransaction(hash: string): Promise<TransactionLookup> {
    const { body, nodeLedger } = await this.getJson<{ successful?: boolean; ledger?: number; created_at?: string; envelope_xdr?: string; result_xdr?: string }>(
      `/transactions/${encodeURIComponent(hash)}`,
    );
    if (!body) return { found: null, nodeLedger };
    if (typeof body.ledger !== "number" || !body.created_at || !body.envelope_xdr || !body.result_xdr) throw unavailable();
    return {
      found: {
        successful: body.successful === true,
        ledger: body.ledger,
        closedAt: new Date(body.created_at),
        envelopeXdr: body.envelope_xdr,
        resultXdr: body.result_xdr,
      },
      nodeLedger,
    };
  }

  async submit(signedXdr: string): Promise<SubmitResult> {
    let res: Response;
    try {
      res = await this.slots.run(() =>
        fetch(`${this.base}/transactions`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ tx: signedXdr }).toString(),
          signal: AbortSignal.timeout(this.submitTimeoutMs),
        }),
      );
    } catch {
      return { kind: "unknown" };
    }
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) {
      const b = body as { successful?: boolean; ledger?: number; created_at?: string } | null;
      if (b && b.successful !== false && typeof b.ledger === "number") {
        // Horizon's submit response has no close time; callers read it from the ledger record.
        return { kind: "success", ledger: b.ledger, closedAt: b.created_at ? new Date(b.created_at) : null };
      }
      return { kind: "unknown" };
    }
    if (res.status === 400) {
      const codes = (body as { extras?: { result_codes?: { transaction?: string; operations?: string[] } } } | null)?.extras
        ?.result_codes;
      if (codes?.transaction) return { kind: "failed", txCode: codes.transaction, opCodes: codes.operations ?? [] };
    }
    // 504 (Horizon gave up waiting), other 5xx, rate limits: the outcome is not known yet.
    return { kind: "unknown" };
  }
}
