import js from "@eslint/js";
import tseslint from "typescript-eslint";

const MONEY_RULES = [
  {
    selector: "CallExpression[callee.name='parseFloat'], CallExpression[callee.object.name='Number'][callee.property.name='parseFloat']",
    message: "Money is never a float. Use parseAmount() from lib/amount (bigint stroops).",
  },
  {
    selector: "CallExpression[callee.name='Number']",
    message: "Number() is banned (it silently turns amounts into floats). Use parseAmount() for money or Number.parseInt(x, 10) for integers.",
  },
];

const STATUS_RULE = {
  selector:
    "CallExpression[callee.property.name=/^(update|updateMany|upsert|create|createMany)$/][callee.object.property.name=/^(payrollRun|payrollItem|payrollBatch)$/] Property[key.name='data'] Property[key.name='status']",
  message: "Only modules/payroll/transitions.ts may change a run, line or batch status.",
};

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "openapi.json"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": ["error", { "ts-ignore": "allow-with-description", "ts-expect-error": "allow-with-description" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-control-regex": "off",
      "no-restricted-syntax": ["error", ...MONEY_RULES, STATUS_RULE],
    },
  },
  {
    // transitions.ts is the one place statuses change. The seed script writes demo rows that
    // are already in their final states, straight to a local database.
    files: ["src/modules/payroll/transitions.ts", "scripts/seed.ts"],
    rules: { "no-restricted-syntax": ["error", ...MONEY_RULES] },
  },
);
