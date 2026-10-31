import { buildApp } from "./app";
import { env, isProduction } from "./config/env";
import { prisma } from "./db/prisma";
import { logger } from "./lib/logger";
import { createMailer } from "./lib/mailer";
import { HorizonGateway } from "./stellar/horizonGateway";

// api process

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  const { app } = buildApp({
    prisma,
    stellar: new HorizonGateway(env.HORIZON_URL),
    logger,
    mailer: createMailer({ smtpUrl: env.SMTP_URL, from: env.MAIL_FROM, production: isProduction }, logger),
    // Sign-up codes: by default only when a real mail server is configured.
    verifyEmail: env.EMAIL_VERIFICATION === "on" || (env.EMAIL_VERIFICATION === "auto" && Boolean(env.SMTP_URL)),
    batchWindowSeconds: env.BATCH_WINDOW_SECONDS,
  });

  const server = app.listen(env.PORT, env.HOST, () => {
    logger.info({ host: env.HOST, port: env.PORT, env: env.NODE_ENV }, "api listening");
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "api shutting down");
    // Stop accepting, wait up to 10 s, then disconnect Prisma.
    const force = setTimeout(() => {
      logger.warn("shutdown grace period over; closing remaining connections");
      server.closeAllConnections();
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      Promise.allSettled([prisma.$disconnect()])
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
    server.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "api failed to start");
  process.exit(1);
});
