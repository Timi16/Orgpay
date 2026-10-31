// Demo data for local UI work: an organization, a funding wallet, groups, employees and one draft
// run. Writes straight to the database with no Stellar calls, so it creates no payment history:
// every paid payment OrgPay shows must come from a real, verified Testnet transaction (run
// `pnpm proof` for those). The wallets are random and don't exist on Testnet. Never run it
// against a database real people use.
//
//   pnpm seed            (login: demo@orgpay.local / demo-password-123)

import { PrismaClient, type Employee } from "@prisma/client";
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
      runCounter: 1,
    },
  });
  const wallet = await prisma.wallet.create({
    data: { companyId: company.id, address: Keypair.random().publicKey(), label: "Payroll treasury" },
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
          salaryStroops: stroops(amount),
          groupId: groups.get(group) ?? null,
        },
      }),
    );
  }

  const staff = people.filter((p) => p.groupId !== groups.get("Contractors"));
  const run = await prisma.payrollRun.create({
    data: {
      companyId: company.id,
      number: 1,
      name: "November payroll · Engineering + Design",
      payDate: new Date(`${new Date().toISOString().slice(0, 8)}28T00:00:00Z`),
      walletId: wallet.id,
      walletAddress: wallet.address,
      assetCode: "USDC",
      assetIssuer: USDC_ISSUER,
      createdVia: "dashboard",
    },
  });
  await prisma.payrollItem.createMany({
    data: staff.map((p, i) => ({
      runId: run.id,
      companyId: company.id,
      employeeId: p.id,
      position: i + 1,
      name: p.name,
      walletAddress: p.walletAddress,
      amountStroops: p.salaryStroops,
    })),
  });
  await prisma.payrollEvent.create({ data: { runId: run.id, type: "created", message: "Seeded for local UI work", actor: "system" } });

  console.log(`Seeded ${people.length} employees and 1 draft run. Log in as ${EMAIL} / demo-password-123`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
