import { z } from "zod";
import { SafeText } from "./common";

const Email = z.string().trim().toLowerCase().email().max(254);
// Upper bound keeps argon2 from being used as a CPU-exhaustion vector.
const NewPassword = z.string().min(10, "Password must be at least 10 characters").max(200);

export const SignupBody = z
  .object({
    email: Email,
    password: NewPassword,
    businessName: SafeText(1, 100),
  })
  .strict();
export type SignupBody = z.infer<typeof SignupBody>;

export const LoginBody = z
  .object({
    email: Email,
    password: z.string().min(1).max(200),
    /** false = stay signed in only until the browser closes (and at most a day). Default true: 14 days. */
    remember: z.boolean().optional(),
  })
  .strict();

/** The six-digit code emailed at sign-up. Spaces are forgiven. */
export const VerifyEmailBody = z
  .object({ code: z.string().transform((v) => v.replace(/\s+/g, "")).pipe(z.string().regex(/^\d{6}$/, "Enter the 6-digit code")) })
  .strict();
export type VerifyEmailBody = z.infer<typeof VerifyEmailBody>;

export const ForgotPasswordBody = z.object({ email: Email }).strict();
export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBody>;

export const ResetPasswordBody = z
  .object({ token: z.string().min(20).max(128).regex(/^[A-Za-z0-9_-]+$/, "Invalid reset link"), newPassword: NewPassword })
  .strict();
export type ResetPasswordBody = z.infer<typeof ResetPasswordBody>;
export type LoginBody = z.infer<typeof LoginBody>;

export const ChangePasswordBody = z
  .object({ currentPassword: z.string().min(1).max(200), newPassword: NewPassword })
  .strict();
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;

/** Any subset of the company's settings; at least one field. */
export const UpdateSettingsBody = z
  .object({
    businessName: SafeText(1, 100),
    /** Email when a run finishes with everyone paid. */
    notifyPaid: z.boolean(),
    /** Email when a run finishes with lines that failed. */
    notifyProblems: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Send at least one setting to change");
export type UpdateSettingsBody = z.infer<typeof UpdateSettingsBody>;

export const CompanySchema = z.object({
  id: z.string(),
  email: z.string(),
  /** False until the code emailed at sign-up has been entered. The dashboard is locked until then. */
  emailVerified: z.boolean(),
  businessName: z.string(),
  notifyPaid: z.boolean(),
  notifyProblems: z.boolean(),
  createdAt: z.string(),
});
export type Company = z.infer<typeof CompanySchema>;
export const CompanyResponse = z.object({ company: CompanySchema });

/** Closing the account needs the current password and the word CLOSE. Wallets and funds are untouched. */
export const CloseAccountBody = z
  .object({
    password: z.string().min(1).max(200),
    confirm: z.literal("CLOSE", { errorMap: () => ({ message: "Type CLOSE to confirm" }) }),
  })
  .strict();

/** One place the company is signed in. */
export const SessionSchema = z.object({
  id: z.string(),
  /** True for the session making this request. */
  current: z.boolean(),
  createdAt: z.string(),
  /** Last request seen from this session (updated at most every few minutes). */
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export type Session = z.infer<typeof SessionSchema>;
export const SessionListResponse = z.object({ data: z.array(SessionSchema) });
export const SessionIdParamsSchema = z.object({ id: z.string().regex(/^[0-9a-f]{64}$/, "Invalid session id") }).strict();
