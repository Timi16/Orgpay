import { extendZodWithOpenApi, OpenApiGeneratorV3, OpenAPIRegistry, type RouteConfig } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import * as s from "@orgpay/shared";

extendZodWithOpenApi(z);

type Auth = "public" | "session" | "any";

interface RouteSpec {
  method: RouteConfig["method"];
  path: string;
  summary: string;
  tag: string;
  auth: Auth;
  params?: z.AnyZodObject;
  query?: z.AnyZodObject;
  body?: z.ZodTypeAny;
  headers?: z.AnyZodObject;
  /** status -> schema (null = no body) */
  success: Record<number, z.ZodTypeAny | null>;
  errors?: number[];
  description?: string;
}

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "Validation or business-rule failure",
  401: "No or bad session / API key",
  403: "CSRF check failed",
  404: "Missing, or belongs to another company",
  409: "Conflict with the current state",
  429: "Rate limited (see Retry-After)",
  503: "Dependency unavailable",
};

/**
 * The public API reference: what a developer can do with an API key, plus health. Dashboard-only
 * routes (sign-in, sessions, API-key and wallet management) work only with the dashboard's
 * session cookie, so they are left out of the published document.
 */
export function buildOpenApiDocument(serverUrl?: string) {
  const registry = new OpenAPIRegistry();
  registry.registerComponent("securitySchemes", "apiKey", {
    type: "http",
    scheme: "bearer",
    description: "API key: `Authorization: Bearer op_test_…`",
  });

  const ErrorResponse = registry.register("Error", s.ErrorResponseSchema);
  const schemas = {
    Employee: registry.register("Employee", s.EmployeeSchema),
    Group: registry.register("Group", s.GroupSchema),
    PayrollRun: registry.register("PayrollRun", s.RunSchema),
    Health: registry.register("Health", s.HealthSchema),
  };
  void schemas.Employee;
  void schemas.Group;
  void schemas.PayrollRun;

  const add = (spec: RouteSpec) => {
    // Dashboard-only: not usable with an API key, so not part of the published reference.
    if (spec.auth === "session" || spec.tag === "Auth") return;
    const responses: RouteConfig["responses"] = {};
    for (const [status, schema] of Object.entries(spec.success)) {
      responses[status] = schema
        ? { description: "Success", content: { "application/json": { schema } } }
        : { description: "Success, no content" };
    }
    const errors = new Set([...(spec.errors ?? []), 429, ...(spec.auth === "public" ? [] : [401])]);
    for (const status of [...errors].sort()) {
      responses[String(status)] = {
        description: ERROR_DESCRIPTIONS[status] ?? "Error",
        content: { "application/json": { schema: ErrorResponse } },
      };
    }
    registry.registerPath({
      method: spec.method,
      path: spec.path,
      summary: spec.summary,
      description: spec.description,
      tags: [spec.tag],
      security:
        spec.auth === "public" ? [] : [{ apiKey: [] }],
      request: {
        ...(spec.params ? { params: spec.params } : {}),
        ...(spec.query ? { query: spec.query } : {}),
        ...(spec.headers ? { headers: spec.headers } : {}),
        ...(spec.body ? { body: { content: { "application/json": { schema: spec.body } } } } : {}),
      },
      responses,
    });
  };

  const noStrict = <T extends z.AnyZodObject>(schema: T) => schema;

  // Auth
  add({ method: "post", path: "/auth/signup", summary: "Create a company account", tag: "Auth", auth: "public", body: s.SignupBody, success: { 201: s.CompanyResponse }, errors: [400, 403, 409] });
  add({ method: "post", path: "/auth/login", summary: "Log in", tag: "Auth", auth: "public", body: s.LoginBody, success: { 200: s.CompanyResponse }, errors: [400, 401, 403] });
  add({ method: "post", path: "/auth/logout", summary: "Log out", tag: "Auth", auth: "session", success: { 204: null }, errors: [403] });
  add({ method: "get", path: "/auth/me", summary: "Current company", tag: "Auth", auth: "session", success: { 200: s.CompanyResponse } });
  add({ method: "post", path: "/auth/password/forgot", summary: "Email a one-hour password reset link (same answer whether or not the account exists)", tag: "Auth", auth: "public", body: s.ForgotPasswordBody, success: { 204: null }, errors: [400, 403, 503] });
  add({ method: "post", path: "/auth/password/reset", summary: "Set a new password from an emailed link; signs out everywhere", tag: "Auth", auth: "public", body: s.ResetPasswordBody, success: { 204: null }, errors: [400, 403] });
  add({ method: "get", path: "/auth/sessions", summary: "Where the company is signed in", tag: "Auth", auth: "session", success: { 200: s.SessionListResponse } });
  add({ method: "delete", path: "/auth/sessions/{id}", summary: "Sign one session out", tag: "Auth", auth: "session", params: s.SessionIdParamsSchema, success: { 204: null }, errors: [403, 404] });
  add({ method: "post", path: "/auth/sessions/logout-others", summary: "Sign out every other session", tag: "Auth", auth: "session", success: { 204: null }, errors: [403] });
  add({ method: "post", path: "/auth/settings", summary: "Update company settings (name, notification emails)", tag: "Auth", auth: "session", body: s.UpdateSettingsBody, success: { 200: s.CompanyResponse }, errors: [400, 403] });
  add({ method: "post", path: "/auth/password", summary: "Change password (other sessions are signed out)", tag: "Auth", auth: "session", body: s.ChangePasswordBody, success: { 204: null }, errors: [400, 403] });

  // API keys
  add({ method: "get", path: "/v1/api-keys", summary: "List API keys", tag: "API keys", auth: "session", success: { 200: s.ApiKeyListResponse } });
  add({ method: "post", path: "/v1/api-keys", summary: "Create an API key (full key shown once)", tag: "API keys", auth: "session", body: s.CreateApiKeyBody, success: { 201: s.ApiKeyCreatedResponse }, errors: [400, 403, 409] });
  add({ method: "delete", path: "/v1/api-keys/{id}", summary: "Revoke an API key", tag: "API keys", auth: "session", params: noStrict(s.IdParamsSchema), success: { 204: null }, errors: [403, 404] });

  // Wallets
  add({ method: "get", path: "/v1/wallets", summary: "List wallets", tag: "Wallets", auth: "session", success: { 200: s.WalletListResponse } });
  add({ method: "post", path: "/v1/wallets", summary: "Add a funding wallet", tag: "Wallets", auth: "session", body: s.AddWalletBody, success: { 201: s.WalletResponse }, errors: [400, 403, 409] });
  add({ method: "post", path: "/v1/wallets/{id}/refresh", summary: "Re-check the account and trustlines on Horizon", tag: "Wallets", auth: "session", params: s.IdParamsSchema, success: { 200: s.WalletResponse }, errors: [403, 404, 503] });
  add({ method: "post", path: "/v1/wallets/{id}/challenge", summary: "Issue an ownership challenge to sign (SEP-53)", tag: "Wallets", auth: "session", params: s.IdParamsSchema, success: { 200: s.ChallengeResponse }, errors: [403, 404] });
  add({ method: "post", path: "/v1/wallets/{id}/verify", summary: "Verify the signed challenge", tag: "Wallets", auth: "session", params: s.IdParamsSchema, body: s.VerifyWalletBody, success: { 200: s.WalletResponse }, errors: [400, 403, 404] });
  add({ method: "delete", path: "/v1/wallets/{id}", summary: "Remove a funding wallet (refused while an open run uses it)", tag: "Wallets", auth: "session", params: s.IdParamsSchema, success: { 204: null }, errors: [403, 404] });

  // Groups
  add({ method: "get", path: "/v1/groups", summary: "List groups", tag: "People", auth: "any", success: { 200: s.GroupListResponse } });
  add({ method: "post", path: "/v1/groups", summary: "Create a group", tag: "People", auth: "any", body: s.GroupNameBody, success: { 201: s.GroupResponse }, errors: [400, 403, 409] });
  add({ method: "patch", path: "/v1/groups/{id}", summary: "Rename a group", tag: "People", auth: "any", params: s.IdParamsSchema, body: s.GroupNameBody, success: { 200: s.GroupResponse }, errors: [400, 403, 404, 409] });
  add({ method: "delete", path: "/v1/groups/{id}", summary: "Delete a group (its people become ungrouped)", tag: "People", auth: "any", params: s.IdParamsSchema, success: { 204: null }, errors: [403, 404] });

  // Employees
  add({ method: "get", path: "/v1/employees", summary: "List people", description: "Sorted by name. `groupId=none` lists people in no group.", tag: "People", auth: "any", query: s.EmployeeListQuery, success: { 200: s.EmployeeListResponse }, errors: [400] });
  add({ method: "post", path: "/v1/employees", summary: "Add a person", description: "Their wallet is checked on Stellar Testnet right away (best effort): it must exist and have a USDC trustline to be paid.", tag: "People", auth: "any", body: s.CreateEmployeeBody, success: { 201: s.EmployeeResponse }, errors: [400, 403, 404, 409] });
  add({ method: "post", path: "/v1/employees/import", summary: "Import people", description: "Up to 500 at once, all or nothing. Groups are matched by name and created when missing.", tag: "People", auth: "any", body: s.ImportEmployeesBody, success: { 201: s.ImportEmployeesResponse }, errors: [400, 403, 409, 413] });
  add({ method: "post", path: "/v1/employees/check", summary: "Re-check wallets", description: "Fresh Stellar check of the given people (or the 200 checked longest ago).", tag: "People", auth: "any", body: s.CheckEmployeesBody, success: { 200: z.object({ data: z.array(s.EmployeeSchema) }) }, errors: [400, 403, 503] });
  add({ method: "get", path: "/v1/employees/{id}", summary: "Get a person", tag: "People", auth: "any", params: s.IdParamsSchema, success: { 200: s.EmployeeResponse }, errors: [404] });
  add({ method: "patch", path: "/v1/employees/{id}", summary: "Update a person", tag: "People", auth: "any", params: s.IdParamsSchema, body: s.UpdateEmployeeBody, success: { 200: s.EmployeeResponse }, errors: [400, 403, 404, 409] });
  add({ method: "post", path: "/v1/employees/{id}/archive", summary: "Archive a person", description: "Left out of new runs; kept on old ones.", tag: "People", auth: "any", params: s.IdParamsSchema, success: { 200: s.EmployeeResponse }, errors: [403, 404] });
  add({ method: "post", path: "/v1/employees/{id}/restore", summary: "Restore an archived person", tag: "People", auth: "any", params: s.IdParamsSchema, success: { 200: s.EmployeeResponse }, errors: [403, 404, 409] });

  // Payroll runs
  add({ method: "get", path: "/v1/payroll-runs", summary: "List payroll runs", tag: "Payroll", auth: "any", query: s.RunListQuery, success: { 200: s.RunListResponse }, errors: [400] });
  add({ method: "post", path: "/v1/payroll-runs", summary: "Create a draft run", description: "One line per active person in the groups and people given, at their default amount.", tag: "Payroll", auth: "any", body: s.CreateRunBody, success: { 201: s.RunResponse }, errors: [400, 403, 404, 409] });
  add({ method: "get", path: "/v1/payroll-runs/{id}", summary: "Get a run", description: "Every line with its status, failure reason and transaction hash; the batches; the history.", tag: "Payroll", auth: "any", params: s.IdParamsSchema, success: { 200: s.RunResponse }, errors: [404] });
  add({ method: "patch", path: "/v1/payroll-runs/{id}", summary: "Rename, re-date or change the funding wallet (draft)", tag: "Payroll", auth: "any", params: s.IdParamsSchema, body: s.UpdateRunBody, success: { 200: s.RunResponse }, errors: [400, 403, 404, 409] });
  add({ method: "delete", path: "/v1/payroll-runs/{id}", summary: "Delete a draft", tag: "Payroll", auth: "any", params: s.IdParamsSchema, success: { 204: null }, errors: [403, 404, 409] });
  add({ method: "post", path: "/v1/payroll-runs/{id}/items", summary: "Add people or groups (draft)", tag: "Payroll", auth: "any", params: s.IdParamsSchema, body: s.AddItemsBody, success: { 200: s.RunResponse }, errors: [400, 403, 404, 409] });
  add({ method: "patch", path: "/v1/payroll-runs/{id}/items/{itemId}", summary: "Change a line's amount (draft)", tag: "Payroll", auth: "any", params: s.RunItemParams, body: s.UpdateItemBody, success: { 200: s.RunResponse }, errors: [400, 403, 404, 409] });
  add({ method: "delete", path: "/v1/payroll-runs/{id}/items/{itemId}", summary: "Remove a line (draft)", tag: "Payroll", auth: "any", params: s.RunItemParams, success: { 200: s.RunResponse }, errors: [403, 404, 409] });
  add({ method: "get", path: "/v1/payroll-runs/{id}/check", summary: "Pre-flight check", description: "Read-only. Who can receive USDC right now, and whether the funding wallet covers the rest plus fees.", tag: "Payroll", auth: "any", params: s.IdParamsSchema, success: { 200: s.RunCheckResponse }, errors: [404, 503] });
  add({ method: "post", path: "/v1/payroll-runs/{id}/start", summary: "Start paying", description: "Checks everyone fresh. People who can't receive are marked failed and never sent anything; if the funding wallet can't cover the rest, nothing changes (400 INSUFFICIENT_FUNDS).", tag: "Payroll", auth: "any", params: s.IdParamsSchema, success: { 200: s.RunResponse }, errors: [400, 403, 404, 409, 503] });
  add({ method: "post", path: "/v1/payroll-runs/{id}/batches/next", summary: "Get the next batch to sign", description: "Up to 100 payments in one unsigned transaction (base64 XDR) from the funding wallet, valid for a few minutes. While a batch is open the same one is returned. `batch: null` means nothing to sign right now.", tag: "Payroll", auth: "any", params: s.IdParamsSchema, success: { 200: s.NextBatchResponse }, errors: [400, 403, 404, 409, 503] });
  add({ method: "post", path: "/v1/payroll-runs/{id}/batches/{batchId}/submit", summary: "Submit a signed batch", description: "The signed transaction must be exactly the one OrgPay built (400 TX_MISMATCH otherwise). 200 when Stellar gave a final answer, 202 when it is still pending (the worker settles it).", tag: "Payroll", auth: "any", params: s.RunBatchParams, body: s.SubmitBatchBody, success: { 200: s.SubmitBatchResponse, 202: s.SubmitBatchResponse }, errors: [400, 403, 404, 409] });
  add({ method: "post", path: "/v1/payroll-runs/{id}/retry", summary: "Retry failed payments", description: "Failed lines that now pass a fresh check go back in the queue; a paid line is never sent again.", tag: "Payroll", auth: "any", params: s.IdParamsSchema, body: s.RetryBody, success: { 200: s.RunResponse }, errors: [400, 403, 404, 409, 503] });
  add({ method: "post", path: "/v1/payroll-runs/{id}/cancel", summary: "Cancel", description: "A draft, or the unsent payments of a run being paid (not while a batch is open).", tag: "Payroll", auth: "any", params: s.IdParamsSchema, success: { 200: s.RunResponse }, errors: [403, 404, 409] });
  add({ method: "get", path: "/v1/summary", summary: "Overview numbers", tag: "Payroll", auth: "any", success: { 200: s.SummarySchema } });

  add({ method: "get", path: "/health", summary: "Health", description: "Database status and the number of batches still open.", tag: "System", auth: "public", success: { 200: schemas.Health }, errors: [503] });

  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.3",
    info: {
      title: "OrgPay API",
      version: "1.0.0",
      description: [
        "Run payroll in USDC on **Stellar Testnet**: people, groups, runs, and every payment tracked to its transaction hash. No real money moves.",
        "",
        "OrgPay never holds a secret key. It builds each batch as an unsigned transaction; you sign it with the funding wallet (Freighter in the dashboard, or your own signer) and send it back.",
        "",
        "## Getting started",
        "1. In the dashboard, add your funding wallet and create an API key under **API keys** (shown once).",
        "2. Send it on every request: `Authorization: Bearer op_test_…`.",
        "3. `POST /v1/employees` for each person, then `POST /v1/payroll-runs`.",
        "4. `POST /start`, then loop: `POST /batches/next` → sign the XDR → `POST /batches/{batchId}/submit`, until `batch` is null.",
        "",
        "## Conventions",
        "- **Amounts** are decimal strings with up to 7 decimals (`\"1500\"`, `\"0.5\"`); responses also carry the exact value in stroops.",
        "- **Errors** share one shape: `{ error: { code, message, details, requestId } }`.",
        "- **Pagination**: lists take `limit` and `cursor` and return `{ data, nextCursor }`.",
        "- **Rate limit**: 300 requests a minute per account; a 429 carries `Retry-After`.",
      ].join("\n"),
    },
    tags: [
      { name: "People", description: "Employees, their wallets and default amounts, and groups." },
      { name: "Payroll", description: "Draft a run, check it, start it, sign each batch, and follow every payment." },
      { name: "System" },
    ],
    servers: serverUrl ? [{ url: serverUrl }] : [],
  });
}
