import { apiReference } from "@scalar/express-api-reference";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env";
import { DEFAULT_LIMITS, type AppDeps, type Limits } from "./deps";
import type { Mailer } from "./lib/mailer";
import { requireAny, requireSession, requireVerifiedEmail, sessionOnly, authOf } from "./middleware/auth";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { PgRateLimitStore } from "./middleware/pgRateLimitStore";
import { idempotency } from "./middleware/idempotency";
import { limiter } from "./middleware/rateLimit";
import { requestId } from "./middleware/requestId";
import { rejectNulBytes } from "./middleware/validate";
import { requireOrigin } from "./middleware/requireOrigin";
import { apiKeyRoutes } from "./modules/apiKeys/routes";
import { createApiKeyService } from "./modules/apiKeys/service";
import { authRoutes } from "./modules/auth/routes";
import { createAuthService } from "./modules/auth/service";
import { healthRoutes } from "./modules/health/routes";
import { employeeRoutes } from "./modules/employees/routes";
import { createEmployeeService } from "./modules/employees/service";
import { groupRoutes } from "./modules/groups/routes";
import { createGroupService } from "./modules/groups/service";
import { paymentRoutes, payrollRoutes } from "./modules/payroll/routes";
import { createPayrollService } from "./modules/payroll/service";
import { summaryRoutes } from "./modules/summary/routes";
import { createSummaryService } from "./modules/summary/service";
import { walletRoutes } from "./modules/wallets/routes";
import { createWalletService } from "./modules/wallets/service";
import { buildOpenApiDocument } from "./openapi/registry";

export interface BuiltApp {
  app: Express;
}

export type BuildAppDeps = Omit<AppDeps, "limits" | "mailer" | "verifyEmail" | "batchWindowSeconds"> & {
  limits?: Partial<Limits>;
  mailer?: Mailer | null;
  verifyEmail?: boolean;
  batchWindowSeconds?: number;
};

/** Wires everything in a fixed order. Tests import this same function. */
export function buildApp(input: BuildAppDeps): BuiltApp {
  const mailer = input.mailer ?? null;
  const deps: AppDeps = {
    ...input,
    mailer,
    // Confirmation needs a way to deliver the code.
    verifyEmail: Boolean(input.verifyEmail) && mailer !== null,
    limits: { ...DEFAULT_LIMITS, ...input.limits },
    batchWindowSeconds: input.batchWindowSeconds ?? 300,
  };
  const { limits, prisma } = deps;
  const app = express();

  // 1. Behind Caddy: trust exactly one proxy hop so req.ip is the real client.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.set("query parser", "simple");

  // 2-3. Request id, then logging (secrets are redacted by the logger).
  app.use(requestId);
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (req) => (req as express.Request).requestId,
      autoLogging: { ignore: (req) => req.url === "/health" },
      // Query strings are dropped from logs: they can carry cursors and search terms.
      serializers: {
        req: (req: { method: string; url: string; id: unknown }) => ({
          id: req.id,
          method: req.method,
          url: req.url.split("?")[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  // 4. Security headers. The API serves JSON only, so nothing may frame or load from it.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  // 5. CORS: credentials only for the web origin on /auth and /v1; public routes are open.
  const credentialedCors = cors({
    origin: env.WEB_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id", "Retry-After"],
    maxAge: 600,
  });
  const openCors = cors({ origin: "*", methods: ["GET"], exposedHeaders: ["X-Request-Id", "Retry-After"] });
  app.use("/auth", credentialedCors);
  app.use("/v1", credentialedCors);
  app.use(["/health", "/openapi.json"], openCors);

  // 6. Body parsing.
  const smallJson = express.json({ limit: "50kb" });
  // Bulk employee import is the one route that takes a bigger body.
  const importJson = express.json({ limit: "200kb" });
  app.use((req, res, next) => (req.method === "POST" && req.path === "/v1/employees/import" ? importJson : smallJson)(req, res, next));
  app.use(cookieParser());
  app.use(rejectNulBytes);

  // 7. Routes.
  const walletService = createWalletService(deps);

  app.use("/health", healthRoutes(deps));

  let openApiDocument: ReturnType<typeof buildOpenApiDocument> | null = null;
  app.get("/openapi.json", (req, res) => {
    // The server URL is this API as the caller reached it, so "try it" and the samples point here.
    openApiDocument ??= buildOpenApiDocument(`${req.protocol}://${req.get("host") ?? "localhost"}`);
    res.json(openApiDocument);
  });
  app.use(
    "/docs",
    (_req, res, next) => {
      // The reference UI loads its bundle from a CDN; relax the JSON-only CSP for this page.
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net https://fonts.scalar.com; img-src 'self' data: https:; connect-src 'self' https:; frame-ancestors 'none'",
      );
      next();
    },
    apiReference({
      url: "/openapi.json",
      pageTitle: "OrgPay API reference",
      // A plain reference: no editor toolbar, AI assistant, MCP generator or usage telemetry.
      showDeveloperTools: "never",
      agent: { disabled: true },
      mcp: { disabled: true },
      telemetry: false,
      hideClientButton: true,
      defaultOpenAllTags: true,
      authentication: { preferredSecurityScheme: "apiKey" },
    }),
  );

  app.use(
    "/auth",
    requireOrigin,
    authRoutes(createAuthService(deps), {
      // Shared across instances: this is the brute-force limit.
      credentialLimiter: limiter({ limit: limits.authPerMin, store: new PgRateLimitStore(prisma, "auth:") }),
      readLimiter: limiter({ limit: limits.authReadPerMin }),
      requireSession: requireSession(prisma),
    }),
  );

  const v1 = express.Router();
  v1.use(limiter({ limit: limits.v1PerIpPerMin }));
  v1.use(requireAny(prisma));
  v1.use(requireOrigin);
  v1.use(requireVerifiedEmail);
  v1.use(limiter({ limit: limits.v1PerMin, key: (req) => `company:${authOf(req).companyId}` }));
  // A run check can mean a thousand Horizon lookups: these routes get their own, much lower, budget so
  // one company can't exhaust the shared Horizon allowance for everyone.
  v1.use(
    ["/payroll-runs/:id/check", "/payroll-runs/:id/start", "/payroll-runs/:id/retry", "/payroll-runs/:id/transactions/next", "/payments/:id/verify", "/employees/check"],
    limiter({ limit: limits.stellarHeavyPerMin, key: (req) => `stellar:${authOf(req).companyId}` }),
  );
  // Repeated writes replay the first response. Creating a run must carry a key: a repeat would
  // otherwise make a second payroll run.
  v1.use(idempotency(prisma, deps.logger, (req) => req.method === "POST" && req.path === "/payroll-runs"));
  v1.use("/api-keys", sessionOnly, apiKeyRoutes(createApiKeyService(deps)));
  v1.use("/wallets", sessionOnly, walletRoutes(walletService));
  v1.use("/groups", groupRoutes(createGroupService(deps)));
  v1.use("/employees", employeeRoutes(createEmployeeService(deps)));
  const payrollService = createPayrollService(deps);
  v1.use("/payroll-runs", payrollRoutes(payrollService));
  v1.use("/payments", paymentRoutes(payrollService));
  v1.use("/summary", summaryRoutes(createSummaryService(deps)));
  app.use("/v1", v1);

  // 8. 404, then the error handler.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app };
}
