import type { Trustline } from "@orgpay/shared";
import { TransactionBuilder, xdr, type Transaction } from "@stellar/stellar-sdk";
import { formatStroops, parseAmount } from "../../src/lib/amount";
import { AppError } from "../../src/lib/errors";
import type { AccountState, FoundTransaction, LedgerInfo, StellarGateway, SubmitResult, TransactionLookup } from "../../src/stellar/gateway";

export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const FAKE_ISSUER = "GAGVZMODPYFTULIVSY3RGFADIC5LF4LLSN37N4MFWGNZ57TYBXL2LQQX";
const PASSPHRASE = "Test SDF Network ; September 2015";

export function usdcTrustline(over: Partial<Trustline> = {}): Trustline {
  return {
    code: "USDC",
    issuer: USDC_ISSUER,
    limit: "922337203685.4775807",
    balance: "0.0000000",
    buyingLiabilities: "0.0000000",
    sellingLiabilities: "0.0000000",
    authorized: true,
    ...over,
  };
}

interface FakeAccount {
  sequence: bigint;
  xlm: bigint;
  /** null = no USDC trustline. */
  usdc: { balance: bigint; limit: bigint; authorized: boolean } | null;
  subentries: number;
}

const units = (v: string) => {
  const s = parseAmount(v);
  if (s === null) throw new Error(`bad amount ${v}`);
  return s;
};

type SubmitMode = "apply" | "unknown" | { reject: string };

function paymentResult(code: string): xdr.OperationResult {
  const pr =
    code === "op_success"
      ? xdr.PaymentResult.paymentSuccess()
      : code === "op_no_trust"
        ? xdr.PaymentResult.paymentNoTrust()
        : code === "op_no_destination"
          ? xdr.PaymentResult.paymentNoDestination()
          : code === "op_not_authorized"
            ? xdr.PaymentResult.paymentNotAuthorized()
            : code === "op_line_full"
              ? xdr.PaymentResult.paymentLineFull()
              : xdr.PaymentResult.paymentUnderfunded();
  return xdr.OperationResult.opInner(xdr.OperationResultTr.payment(pr));
}

export function resultXdr(ok: boolean, opCodes: string[]): string {
  const ops = opCodes.map(paymentResult);
  return new xdr.TransactionResult({
    feeCharged: 100n * BigInt(opCodes.length),
    result: ok ? xdr.TransactionResultResult.txSuccess(ops) : xdr.TransactionResultResult.txFailed(ops),
    ext: xdr.TransactionResultExt.v0(),
  }).toXdr("base64");
}

/**
 * A small in-memory Stellar: accounts with XLM and USDC, sequence numbers, timebounds, a ledger
 * clock, and all-or-nothing transactions. Unknown addresses exist with an empty USDC trustline.
 */
export class FakeStellar implements StellarGateway {
  readonly accounts = new Map<string, FakeAccount | null>();
  readonly txs = new Map<string, FoundTransaction>();
  /** Signed envelopes accepted with an "unknown" outcome, which can be landed later. */
  readonly inFlight: string[] = [];
  /** Hashes a lagging Horizon node doesn't know about yet: it answers 404 from a few ledgers behind. */
  readonly lagging = new Set<string>();
  ledger = 1000;
  ledgerTime = new Date();
  down = false;
  submitMode: SubmitMode = "apply";
  submits = 0;
  loads = 0;

  private account(address: string): FakeAccount | null {
    if (!this.accounts.has(address)) {
      this.accounts.set(address, { sequence: 100n, xlm: units("10"), usdc: { balance: 0n, limit: units("922337203685"), authorized: true }, subentries: 1 });
    }
    return this.accounts.get(address) ?? null;
  }

  // ---- setup helpers ----
  fund(address: string, usdc: string, xlm = "100"): void {
    const a = this.account(address) ?? { sequence: 100n, xlm: 0n, usdc: null, subentries: 1 };
    a.xlm = units(xlm);
    a.usdc = { balance: units(usdc), limit: units("922337203685"), authorized: true };
    this.accounts.set(address, a);
  }
  noAccount(address: string): void {
    this.accounts.set(address, null);
  }
  noTrustline(address: string): void {
    const a = this.account(address) ?? { sequence: 100n, xlm: units("10"), usdc: null, subentries: 0 };
    a.usdc = null;
    a.subentries = 0;
    this.accounts.set(address, a);
  }
  addTrustline(address: string): void {
    const a = this.account(address);
    if (a && !a.usdc) a.usdc = { balance: 0n, limit: units("922337203685"), authorized: true };
  }
  setTrustline(address: string, over: { limit?: string; authorized?: boolean }): void {
    const a = this.account(address);
    if (!a?.usdc) throw new Error("no trustline");
    if (over.limit !== undefined) a.usdc.limit = units(over.limit);
    if (over.authorized !== undefined) a.usdc.authorized = over.authorized;
  }
  usdcBalance(address: string): string {
    const a = this.accounts.get(address);
    return a?.usdc ? formatStroops(a.usdc.balance) : "none";
  }
  /** Something else used the funding account's next sequence number. */
  bumpSequence(address: string): void {
    const a = this.account(address);
    if (a) a.sequence += 1n;
  }
  closeLedger(ms = 5000): void {
    this.ledger++;
    this.ledgerTime = new Date(this.ledgerTime.getTime() + ms);
  }

  // ---- StellarGateway ----
  async loadAccount(address: string): Promise<AccountState> {
    this.loads++;
    if (this.down) throw new AppError("HORIZON_UNAVAILABLE", "Horizon is down");
    const a = this.account(address);
    if (!a) return { exists: false };
    return {
      exists: true,
      sequence: a.sequence.toString(),
      nativeBalance: formatStroops(a.xlm),
      nativeSellingLiabilities: "0.0000000",
      subentries: a.subentries,
      sponsoring: 0,
      sponsored: 0,
      trustlines: a.usdc
        ? [usdcTrustline({ balance: formatStroops(a.usdc.balance), limit: formatStroops(a.usdc.limit), authorized: a.usdc.authorized })]
        : [],
    };
  }

  async latestLedger(): Promise<LedgerInfo> {
    if (this.down) throw new AppError("HORIZON_UNAVAILABLE", "Horizon is down");
    return { sequence: this.ledger, closedAt: this.ledgerTime };
  }

  async getTransaction(hash: string): Promise<TransactionLookup> {
    if (this.down) throw new AppError("HORIZON_UNAVAILABLE", "Horizon is down");
    if (this.lagging.has(hash)) return { found: null, nodeLedger: this.ledger - 3 };
    return { found: this.txs.get(hash) ?? null, nodeLedger: this.ledger };
  }

  async submit(signedXdr: string): Promise<SubmitResult> {
    this.submits++;
    const mode = this.submitMode;
    if (mode === "unknown") {
      this.inFlight.push(signedXdr);
      return { kind: "unknown" };
    }
    if (typeof mode === "object") return { kind: "failed", txCode: mode.reject, opCodes: [] };
    return this.apply(signedXdr);
  }

  /** Lands every envelope that was left in flight. */
  landInFlight(): SubmitResult[] {
    return this.inFlight.splice(0).map((x) => this.apply(x));
  }

  /** Applies a signed envelope to the ledger, as the network would (also used for out-of-band submission). */
  apply(signedXdr: string): SubmitResult {
    const tx = TransactionBuilder.fromXDR(signedXdr, PASSPHRASE) as Transaction;
    const hash = Buffer.from(tx.hash()).toString("hex");
    if (this.txs.has(hash)) return { kind: "failed", txCode: "tx_bad_seq", opCodes: [] }; // already applied
    const source = this.account(tx.source);
    if (!source) return { kind: "failed", txCode: "tx_no_account", opCodes: [] };
    const maxTime = Number.parseInt(tx.timeBounds?.maxTime ?? "0", 10);
    if (maxTime > 0 && this.ledgerTime.getTime() / 1000 > maxTime) return { kind: "failed", txCode: "tx_too_late", opCodes: [] };
    if (BigInt(tx.sequence) !== source.sequence + 1n) return { kind: "failed", txCode: "tx_bad_seq", opCodes: [] };

    // All or nothing: work on copies, commit only if every operation succeeds.
    source.sequence += 1n;
    this.closeLedger();
    const balances = new Map<string, bigint>();
    const bal = (addr: string) => balances.get(addr) ?? this.accounts.get(addr)?.usdc?.balance ?? 0n;
    const opCodes = tx.operations.map((op) => {
      if (op.type !== "payment") return "op_malformed";
      const dest = this.account(op.destination);
      const amount = units(op.amount);
      if (!dest) return "op_no_destination";
      if (!dest.usdc) return "op_no_trust";
      if (!dest.usdc.authorized) return "op_not_authorized";
      if (bal(tx.source) < amount) return "op_underfunded";
      if (bal(op.destination) + amount > dest.usdc.limit) return "op_line_full";
      balances.set(tx.source, bal(tx.source) - amount);
      balances.set(op.destination, bal(op.destination) + amount);
      return "op_success";
    });
    const ok = opCodes.every((c) => c === "op_success");
    if (ok) {
      for (const [addr, value] of balances) {
        const a = this.accounts.get(addr);
        if (a?.usdc) a.usdc.balance = value;
      }
    }
    this.txs.set(hash, { successful: ok, ledger: this.ledger, closedAt: this.ledgerTime, resultXdr: resultXdr(ok, opCodes) });
    return ok ? { kind: "success", ledger: this.ledger, closedAt: this.ledgerTime } : { kind: "failed", txCode: "tx_failed", opCodes };
  }
}
