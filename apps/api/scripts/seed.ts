// Demo data for local UI work: a company, a funding wallet, groups, people and runs in every
// state. Writes straight to the database (no Stellar calls), so hashes are made up and marked
// as such; never run it against a database real people use.
//
//   pnpm seed            (login: demo@orgpay.local / demo-password-123)

import { randomBytes } from "node:crypto";
import { PrismaClient, type Employee, type ItemStatus, type RunStatus } from "@prisma/client";
import { Keypair } from "@stellar/stellar-sdk";
import argon2 from "argon2";
import { parseAmount } from "@orgpay/shared";

const prisma = new PrismaClient();
const USDC_ISSUER = process.env.USDC_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const EMAIL = "demo@orgpay.local";

const stroops = (v: string) => {
  const s = parseAmount(v);
  if (s === null) throw new Error(`bad amount ${v}`);
  return s;
};
const fakeHash = () => randomBytes(32).toString("hex");

const PEOPLE: [string, string, string, string | null][] = [
  ["Ada Okafor", "Contractors", "3200", "Frontend contractor"],
  ["Kenji Watanabe", "Contractors", "2850", "Illustrator"],
  ["Priya Raman", "Contractors", "4100", "Data contractor"],
  ["Tomás Reyes", "Contractors", "1750", "QA contractor"],
  ["Lena Fischer", "Contractors", "2400", "Copywriter"],
  ["Marcus Silva", "Engineering", "6800", "Staff engineer"],
  ["Amara Nwosu", "Engineering", "6200", "Backend engineer"],
  ["Jonas Berg", "Engineering", "5900", "Platform engineer"],
  ["Sofia Rossi", "Engineering", "6100", "Mobile engineer"],
  ["Daniel Mensah", "Design", "5400", "Product designer"],
  ["Hana Kim", "Design", "5200", "Brand designer"],
  ["Omar Haddad", "Operations", "4300", "Operations lead"],
];

async function main(): Promise<void> {
  const existing = await prisma.company.findUnique({ where: { email: EMAIL } });
  if (existing) {
    await prisma.payrollRun.deleteMany({ where: { companyId: existing.id } });
    await prisma.wallet.deleteMany({ where: { companyId: existing.id } });
    await prisma.company.delete({ where: { id: existing.id } });
  }
  const company = await prisma.company.create({
    data: {
      email: EMAIL,
      passwordHash: await argon2.hash("demo-password-123", { type: argon2.argon2id }),
      businessName: "Northwind Studio",
      emailVerifiedAt: new Date(),
    },
  });
  const funder = Keypair.random().publicKey();
  const wallet = await prisma.wallet.create({
    data: {
      companyId: company.id,
      address: funder,
      label: "Payroll treasury",
      accountExists: true,
      nativeBalance: "250.0000000",
      trustlines: [{ code: "USDC", issuer: USDC_ISSUER, limit: "922337203685.4775807", balance: "61904.1200000", buyingLiabilities: "0.0000000", sellingLiabilities: "0.0000000", authorized: true }],
      checkedAt: new Date(),
    },
  });
  const groups = new Map<string, string>();
  for (const name of new Set(PEOPLE.map((p) => p[1]))) {
    groups.set(name, (await prisma.group.create({ data: { companyId: company.id, name } })).id);
  }
  const people: Employee[] = [];
  for (const [name, group, amount, role] of PEOPLE) {
    people.push(
      await prisma.employee.create({
        data: {
          companyId: company.id,
          name,
          email: `${name.split(" ")[0]?.toLowerCase()}@northwind.studio`,
          role,
          walletAddress: Keypair.random().publicKey(),
          defaultAmountStroops: stroops(amount),
          groupId: groups.get(group) ?? null,
          checkReason: name === "Tomás Reyes" ? "NO_TRUSTLINE" : null,
          checkedAt: new Date(),
        },
      }),
    );
  }

  let number = 0;
  const run = async (name: string, status: RunStatus, picked: typeof people, daysAgo: number, lineStatus: (i: number) => ItemStatus) => {
    const when = new Date(Date.now() - daysAgo * 86_400_000);
    const r = await prisma.payrollRun.create({
      data: {
        companyId: company.id,
        number: ++number,
        name,
        payDate: when,
        walletId: wallet.id,
        walletAddress: wallet.address,
        assetCode: "USDC",
        assetIssuer: USDC_ISSUER,
        status,
        startedAt: status === "DRAFT" ? null : when,
        finishedAt: ["PAID", "PARTIAL", "FAILED"].includes(status) ? when : null,
        notifiedAt: new Date(),
        createdVia: "dashboard",
        createdAt: new Date(when.getTime() - 86_400_000),
      },
    });
    const hash = fakeHash();
    // Only paid lines were in the transaction: a line that can't receive is left out before signing.
    const paidPeople = picked.filter((_, i) => lineStatus(i) === "PAID");
    const batch =
      status === "DRAFT"
        ? null
        : await prisma.payrollBatch.create({
            data: { runId: r.id, companyId: company.id, number: 1, txHash: hash, envelopeXdr: "seed", sequence: "1", maxTime: when, opCount: paidPeople.length, totalStroops: paidPeople.reduce((s, p) => s + p.defaultAmountStroops, 0n), status: "CONFIRMED", ledger: 1_200_000 + number, closedAt: when, submittedAt: when, settledAt: when },
          });
    await prisma.payrollItem.createMany({
      data: picked.map((p, i) => {
        const st = lineStatus(i);
        return {
          runId: r.id,
          companyId: company.id,
          employeeId: p.id,
          position: i + 1,
          name: p.name,
          walletAddress: p.walletAddress,
          amountStroops: p.defaultAmountStroops,
          status: st,
          failureCode: st === "FAILED" ? "NO_TRUSTLINE" : null,
          failureDetail: st === "FAILED" ? "op_no_trust" : null,
          batchId: st === "PAID" ? (batch?.id ?? null) : null,
          opIndex: st === "PAID" ? paidPeople.indexOf(p) : null,
          txHash: st === "PAID" ? hash : null,
          ledger: st === "PAID" ? (batch?.ledger ?? null) : null,
          paidAt: st === "PAID" ? when : null,
          attempts: st === "PENDING" ? 0 : 1,
        };
      }),
    });
    await prisma.payrollEvent.create({ data: { runId: r.id, type: "created", message: "Seeded for local UI work", actor: "system" } });
  };

  const byGroup = (g: string) => people.filter((p) => p.groupId === groups.get(g));
  const staff = people.filter((p) => p.groupId !== groups.get("Contractors"));
  for (let m = 5; m >= 1; m--) await run(`Payroll · ${m} month(s) ago`, "PAID", staff.slice(0, 4 + m), m * 30, () => "PAID");
  const contractors = byGroup("Contractors");
  await run("September contractors", "PARTIAL", contractors, 2, (i) => (contractors[i]?.name === "Tomás Reyes" ? "FAILED" : "PAID"));
  await run("October payroll · Engineering + Design", "DRAFT", staff, -15, () => "PENDING");

  console.log(`Seeded ${people.length} people and ${number} runs. Log in as ${EMAIL} / demo-password-123`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
