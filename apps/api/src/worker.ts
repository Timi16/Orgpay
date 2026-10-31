import { env, isProduction } from "./config/env";
import { isDbUnavailable, prisma } from "./db/prisma";
import { DEFAULT_LIMITS } from "./deps";
import { CONFIRM_INTERVAL_MS, confirmOpenBatches } from "./engine/confirmer";
import { NOTIFY_INTERVAL_MS, notifyRuns } from "./engine/notifier";
import { logger } from "./lib/logger";
import { createMailer } from "./lib/mailer";
import { pruneCounters } from "./modules/auth/throttle";
import { createPayrollService } from "./modules/payroll/service";
import { HorizonGateway } from "./stellar/horizonGateway";

// worker process: batch confirmer, run notifier, housekeeping. Run exactly one.

const controller = new AbortController();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (controller.signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", done);
      resolve();
    }
    controller.signal.addEventListener("abort", done, { once: true });
  });
}

/** Runs `fn` forever. Failures back off 1 s -> 30 s; the loop itself never dies. */
async function loop(name: string, fn: () => Promise<number>, backoff: boolean): Promise<void> {
  let failures = 0;
  while (!controller.signal.aborted) {
    let delay: number;
    try {
      delay = await fn();
      failures = 0;
    } catch (err) {
      failures++;
      delay = backoff ? Math.min(1000 * 2 ** (failures - 1), 30_000) : 5000;
      const level = isDbUnavailable(err) || failures > 1 ? "warn" : "error";
      logger[level]({ err, loop: name, failures, retryInMs: delay }, "worker loop failed");
    }
    await sleep(delay);
  }
}

async function main(): Promise<void> {
  const mailer = createMailer({ smtpUrl: env.SMTP_URL, from: env.MAIL_FROM, production: isProduction }, logger);
  const payroll = createPayrollService({
    prisma,
    stellar: new HorizonGateway(env.HORIZON_URL),
    logger,
    limits: DEFAULT_LIMITS,
    mailer,
    verifyEmail: false,
    batchWindowSeconds: env.BATCH_WINDOW_SECONDS,
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "worker shutting down after the current step");
    controller.abort();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  logger.info({ horizon: env.HORIZON_URL }, "worker started");
  await Promise.all([
    loop("confirmer", async () => (await confirmOpenBatches({ prisma, payroll, logger }), CONFIRM_INTERVAL_MS), true),
    // Run emails need a mail server; without one this loop is simply not started.
    ...(mailer
      ? [loop("notifier", async () => (await notifyRuns({ prisma, mailer, webOrigin: env.WEB_ORIGIN, logger }), NOTIFY_INTERVAL_MS), false)]
      : []),
    loop("housekeeping", async () => (await pruneCounters(prisma), 10 * 60_000), false),
  ]);

  await prisma.$disconnect();
  logger.info("worker stopped");
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "worker crashed");
  process.exit(1);
});
