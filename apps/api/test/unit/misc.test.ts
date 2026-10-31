import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair, Networks, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { EnvSchema, loadEnv } from "../../src/config/env";
import { buildBatchTransaction, checkSignedBatch, transactionMemo } from "../../src/modules/payroll/batches";
import { lineFailure } from "../../src/modules/payroll/settle";
import { BATCH_ALLOWED, ITEM_ALLOWED, RUN_ALLOWED } from "../../src/modules/payroll/transitions";
import { decodeSignature, verifyWalletSignature } from "../../src/modules/wallets/signature";
import { assertWalletAddress } from "../../src/modules/wallets/service";
import { fundingCheck, receiveProblem } from "../../src/stellar/checks";
import type { AccountState } from "../../src/stellar/gateway";
import { decodeResultXdr } from "../../src/stellar/results";
import { REDACT_PATHS } from "../../src/lib/logger";
import { resultXdr, usdcTrustline, USDC_ISSUER } from "../helpers/fakes";

const SEP53_VECTOR = {
  address: "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR", // seed = 32 x 0x01
  message: "OrgPay wallet verification",
  signature: "hCtCrQBvNtXED4O8OKM/LrE0fWKp6dR7/Vgksdc55VL8oHigqNYeTEBmoLhDdQ3yA7C2z9+ji+szJTMPZ5ghBw==",
};

const validEnv = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  HORIZON_URL: "https://horizon-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  USDC_ISSUER,
  WEB_ORIGIN: "https://orgpay.example",
  SESSION_SECRET: "ab".repeat(32),
};

describe("config/env", () => {
  it("accepts a valid testnet configuration and applies defaults", () => {
    expect(loadEnv(validEnv)).toMatchObject({ PORT: 4400, NODE_ENV: "development", LOG_LEVEL: "info", BATCH_WINDOW_SECONDS: 300 });
  });

  it("S4: refuses to boot on any network but testnet", () => {
    expect(() => loadEnv({ ...validEnv, NETWORK_PASSPHRASE: Networks.PUBLIC })).toThrow(/testnet passphrase/);
  });

  it("rejects a short session secret, a bad issuer, a web origin with a path, and missing variables", () => {
    expect(() => loadEnv({ ...validEnv, SESSION_SECRET: "abcd" })).toThrow(/SESSION_SECRET/);
    expect(() => loadEnv({ ...validEnv, USDC_ISSUER: "GABC" })).toThrow(/USDC_ISSUER/);
    expect(() => loadEnv({ ...validEnv, WEB_ORIGIN: "https://orgpay.example/app/" })).toThrow(/WEB_ORIGIN/);
    expect(() => loadEnv({ ...validEnv, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => loadEnv({ ...validEnv, DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it(".env.example lists every variable in env.ts and nothing else", () => {
    const example = readFileSync(resolve(__dirname, "../../../../.env.example"), "utf8");
    const listed = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]).sort();
    expect(listed).toEqual(Object.keys(EnvSchema.shape).sort());
  });
});

describe("wallet signature (SEP-53)", () => {
  it("verifies the recorded test vector, as base64 and as hex", () => {
    const { address, message, signature } = SEP53_VECTOR;
    expect(verifyWalletSignature(address, message, signature)).toBe(true);
    const hex = Buffer.from(signature, "base64").toString("hex");
    expect(verifyWalletSignature(address, message, hex)).toBe(true);
  });

  it("rejects a different message, a different signer and junk", () => {
    const { address, message, signature } = SEP53_VECTOR;
    expect(verifyWalletSignature(address, message + "!", signature)).toBe(false);
    expect(verifyWalletSignature(Keypair.random().publicKey(), message, signature)).toBe(false);
    // A pre-SEP-53 wallet signs the bare message: accepted, but only for the exact message.
    const raw = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).sign(Buffer.from(message));
    expect(verifyWalletSignature(address, message, Buffer.from(raw).toString("base64"))).toBe(true);
    expect(verifyWalletSignature(address, message + "!", Buffer.from(raw).toString("base64"))).toBe(false);
    expect(verifyWalletSignature(address, message, "not a signature")).toBe(false);
    expect(decodeSignature("AAAA")).toBeNull();
  });
});

describe("wallet address rules", () => {
  it("E1: refuses secrets, muxed and invalid addresses without echoing them", () => {
    const kp = Keypair.random();
    expect(() => assertWalletAddress(kp.publicKey())).not.toThrow();
    try {
      assertWalletAddress(kp.secret());
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: "SECRET_KEY_REJECTED" });
      expect(JSON.stringify(err) + String((err as Error).message)).not.toContain(kp.secret());
    }
    expect(() => assertWalletAddress("MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK")).toThrow(/Muxed/);
    expect(() => assertWalletAddress("GABC")).toThrow(/valid Stellar/);
  });
});

describe("status tables", () => {
  it("COMPLETED and CANCELLED runs are final; PARTIALLY_PAID and FAILED go back to PROCESSING (retry), and a FAILED run can be given up on", () => {
    expect(RUN_ALLOWED.COMPLETED).toEqual([]);
    expect(RUN_ALLOWED.CANCELLED).toEqual([]);
    expect(RUN_ALLOWED.PARTIALLY_PAID).toEqual(["PROCESSING"]);
    expect(RUN_ALLOWED.FAILED).toEqual(["PROCESSING", "CANCELLED"]);
    expect(RUN_ALLOWED.DRAFT).toEqual(["PROCESSING", "CANCELLED"]);
  });

  it("R13: a SUCCESSFUL payment never changes again; only FAILED payments can be retried (or given up on)", () => {
    expect(ITEM_ALLOWED.SUCCESSFUL).toEqual([]);
    expect(ITEM_ALLOWED.CANCELLED).toEqual([]);
    expect(ITEM_ALLOWED.FAILED).toEqual(["PENDING", "CANCELLED"]);
    // Nothing goes straight from PENDING to SUCCESSFUL: a payment is only made through a transaction,
    // and only a verified ledger record makes it SUCCESSFUL.
    expect(ITEM_ALLOWED.PENDING).not.toContain("SUCCESSFUL");
    expect(ITEM_ALLOWED.PENDING).not.toContain("SUBMITTED");
    for (const final of ["CONFIRMED", "FAILED", "EXPIRED"] as const) expect(BATCH_ALLOWED[final]).toEqual([]);
  });
});

describe("Stellar results", () => {
  it("R9: decodes per-operation codes from a result XDR the way Horizon reports them", () => {
    expect(decodeResultXdr(resultXdr(false, ["op_success", "op_no_trust", "op_line_full"]))).toEqual({
      txCode: "tx_failed",
      opCodes: ["op_success", "op_no_trust", "op_line_full"],
    });
    expect(decodeResultXdr(resultXdr(true, ["op_success"]))).toEqual({ txCode: "tx_success", opCodes: ["op_success"] });
  });

  it("R9: only recipient-side codes fail a line; the rest were simply not sent", () => {
    expect(lineFailure("op_no_trust")).toBe("NO_TRUSTLINE");
    expect(lineFailure("op_no_destination")).toBe("ACCOUNT_NOT_FOUND");
    expect(lineFailure("op_not_authorized")).toBe("NOT_AUTHORIZED");
    expect(lineFailure("op_line_full")).toBe("TRUSTLINE_LIMIT_TOO_LOW");
    expect(lineFailure("op_malformed")).toBe("PAYMENT_FAILED");
    for (const code of ["op_success", "op_underfunded", "op_src_no_trust", undefined]) expect(lineFailure(code)).toBeNull();
  });
});

describe("checks", () => {
  const usdc = { code: "USDC", issuer: USDC_ISSUER };
  const account = (over: Partial<Extract<AccountState, { exists: true }>> = {}): AccountState => ({
    exists: true,
    sequence: "1",
    nativeBalance: "10.0000000",
    nativeSellingLiabilities: "0.0000000",
    subentries: 1,
    sponsoring: 0,
    sponsored: 0,
    trustlines: [usdcTrustline()],
    ...over,
  });

  it("E6: missing account, no trustline (or another issuer's USDC), unauthorised, limit too low", () => {
    expect(receiveProblem({ exists: false }, usdc, 1n)).toBe("ACCOUNT_NOT_FOUND");
    expect(receiveProblem(account({ trustlines: [] }), usdc, 1n)).toBe("NO_TRUSTLINE");
    expect(receiveProblem(account({ trustlines: [usdcTrustline({ issuer: Keypair.random().publicKey() })] }), usdc, 1n)).toBe("NO_TRUSTLINE");
    expect(receiveProblem(account({ trustlines: [usdcTrustline({ authorized: false })] }), usdc, 1n)).toBe("NOT_AUTHORIZED");
    // Headroom is limit - balance - buying liabilities, to the stroop.
    const line = usdcTrustline({ limit: "100.0000000", balance: "60.0000000", buyingLiabilities: "10.0000000" });
    expect(receiveProblem(account({ trustlines: [line] }), usdc, 300_000_000n)).toBeNull();
    expect(receiveProblem(account({ trustlines: [line] }), usdc, 300_000_001n)).toBe("TRUSTLINE_LIMIT_TOO_LOW");
  });

  it("R4: USDC available is balance minus selling liabilities; XLM must cover fees above the reserve", () => {
    const funded = account({ trustlines: [usdcTrustline({ balance: "1000.0000000", sellingLiabilities: "100.0000000" })] });
    expect(fundingCheck(funded, usdc, 9_000_000_000n, 3)).toMatchObject({ problem: null, usdcAvailable: 9_000_000_000n, feeStroops: 3000n });
    expect(fundingCheck(funded, usdc, 9_000_000_001n, 3)).toMatchObject({ problem: "INSUFFICIENT_USDC", shortBy: 1n });
    // Reserve for 1 subentry is (2 + 1) x 0.5 = 1.5 XLM; 1.5001 XLM covers one 1000-stroop fee only.
    const thin = account({ nativeBalance: "1.5001000", trustlines: funded.exists ? funded.trustlines : [] });
    expect(fundingCheck(thin, usdc, 1n, 1).problem).toBeNull();
    expect(fundingCheck(thin, usdc, 1n, 2).problem).toBe("INSUFFICIENT_XLM");
    expect(fundingCheck({ exists: false }, usdc, 1n, 1).problem).toBe("ACCOUNT_NOT_FOUND");
    expect(fundingCheck(account({ trustlines: [] }), usdc, 1n, 1).problem).toBe("NO_TRUSTLINE");
    // A balance Horizon sent that can't be read never passes as enough.
    expect(() => fundingCheck(account({ trustlines: [usdcTrustline({ balance: "lots" })] }), usdc, 1n, 1)).toThrow();
  });
});

describe("batches", () => {
  const source = Keypair.random();
  const build = () =>
    buildBatchTransaction({
      source: source.publicKey(),
      accountSequence: "41",
      asset: { code: "USDC", issuer: USDC_ISSUER },
      lines: [
        { destination: Keypair.random().publicKey(), amountStroops: 1n },
        { destination: Keypair.random().publicKey(), amountStroops: 15_005_000_000n },
      ],
      memo: transactionMemo(12345, [1, 2], 3),
      maxTime: new Date("2026-10-16T12:05:00Z"),
    });

  it("R6: one exact payment per line, the next sequence, the memo and the timebound", () => {
    const built = build();
    const tx = TransactionBuilder.fromXDR(built.xdr, Networks.TESTNET) as Transaction;
    expect(built.sequence).toBe("42");
    expect(tx.operations.map((o) => (o.type === "payment" ? o.amount : null))).toEqual(["0.0000001", "1500.5000000"]);
    expect(Buffer.from(tx.memo.value as Uint8Array).toString()).toBe("OrgPay R12345 T3");
    expect(tx.timeBounds?.maxTime).toBe(String(Date.parse("2026-10-16T12:05:00Z") / 1000));
    expect(Buffer.from(tx.hash()).toString("hex")).toBe(built.hash);
    expect(transactionMemo(7, [4], 1)).toBe("OrgPay R7 P4");
    expect(Buffer.byteLength(transactionMemo(999999999, [999999], 1))).toBeLessThanOrEqual(28);
    expect(Buffer.byteLength(transactionMemo(999999999, [1, 2], 999999))).toBeLessThanOrEqual(28);
  });

  it("R7: a signed batch must be ours and signed by the funding wallet", () => {
    const built = build();
    const tx = TransactionBuilder.fromXDR(built.xdr, Networks.TESTNET);
    expect(() => checkSignedBatch(tx.toXDR(), { hash: built.hash, source: source.publicKey() })).toThrow(/not signed/);
    tx.sign(source);
    expect(() => checkSignedBatch(tx.toXDR(), { hash: built.hash, source: source.publicKey() })).not.toThrow();
    expect(() => checkSignedBatch(tx.toXDR(), { hash: "00".repeat(32), source: source.publicKey() })).toThrow(/not the transaction/);
    // Signatures don't change the hash, so a second signer is fine, and a wrong one alone is not.
    const other = TransactionBuilder.fromXDR(built.xdr, Networks.TESTNET);
    other.sign(Keypair.random());
    expect(() => checkSignedBatch(other.toXDR(), { hash: built.hash, source: source.publicKey() })).toThrow(/not signed/);
  });
});

describe("logging", () => {
  it("redacts signed transactions, passwords, keys, tokens and signatures", () => {
    for (const path of ["*.signedXdr", "*.password", "*.key", "*.token", "*.signature", "req.headers.authorization", "req.headers.cookie"]) {
      expect(REDACT_PATHS).toContain(path);
    }
  });
});
