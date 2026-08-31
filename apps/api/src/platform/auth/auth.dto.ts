import { mfaCodeOnlySchema, mfaVerifySchema, type MfaChallengeResponse, type MfaSummary } from '@vyuha/shared';
import { z } from 'zod';

import { createZodDto } from '../common/zod-validation.pipe.js';

/**
 * Every request body on the auth surface. Definition of Done: "Zod schema
 * validates every request body."
 *
 * The password field is validated for *shape* here and for *strength* in
 * `password-policy.ts`. Splitting them is deliberate: the shape rule keeps a
 * megabyte of text out of scrypt, while the strength rule produces
 * PASSWORD_TOO_WEAK with the specific rule that failed, which a generic
 * VALIDATION_FAILED from a pipe could not.
 */

/** RFC 5321 caps a path at 256 octets; 254 is the practical maximum address. */
const emailField = z
  .email('must be an email address')
  .max(254)
  .transform((value) => value.trim().toLowerCase());

/**
 * Only an upper bound. A short password is rejected by the policy, not here,
 * so the user is told *why* rather than being handed a field-level complaint.
 * The cap exists because scrypt's cost is linear in input length.
 */
const passwordField = z.string().min(1).max(1024);

const newPasswordField = z.string().min(1).max(1024);

export const loginSchema = z.object({
  email: emailField,
  password: passwordField,
});
export class LoginDto extends createZodDto(loginSchema) {}

export const createInvitationSchema = z.object({
  email: emailField,
  /** REQ-B-02: an invitation may or may not be tied to an employee record. */
  employeeId: z.uuid().nullish(),
  /** REQ-B-07: multiple roles per user. Empty means no role until assigned. */
  roleIds: z.array(z.uuid()).max(20).default([]),
});
export class CreateInvitationDto extends createZodDto(createInvitationSchema) {}

export const acceptInvitationSchema = z.object({
  password: newPasswordField,
});
export class AcceptInvitationDto extends createZodDto(acceptInvitationSchema) {}

export const requestPasswordResetSchema = z.object({
  email: emailField,
});
export class RequestPasswordResetDto extends createZodDto(requestPasswordResetSchema) {}

/**
 * REQ-B-04 triggered by an administrator, which names an employee rather than
 * an address.
 *
 * The address is deliberately not accepted: the public request endpoint already
 * takes one and answers 202 without saying whether it exists, and an
 * authenticated endpoint that returned a live reset link for any address typed
 * into it would be a way to reach accounts in another organisation. The
 * employee id is scoped by the caller's organisation on the way in.
 */
export const issuePasswordResetSchema = z.object({
  employeeId: z.uuid(),
});
export class IssuePasswordResetDto extends createZodDto(issuePasswordResetSchema) {}

export const confirmPasswordResetSchema = z.object({
  password: newPasswordField,
});
export class ConfirmPasswordResetDto extends createZodDto(confirmPasswordResetSchema) {}

/** REQ-B-09: the code step, and the code a person types to change their own enrolment. */
export class MfaVerifyDto extends createZodDto(mfaVerifySchema) {}
export class MfaCodeDto extends createZodDto(mfaCodeOnlySchema) {}

export interface LoginResponse {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresInSeconds: number;
  readonly user: { readonly id: string; readonly email: string };
}

/** A correct password answers with a session, or with the five minutes in which a code is next. */
export type LoginOutcome = LoginResponse | MfaChallengeResponse;

export interface MeResponse {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly status: string;
    readonly employeeId: string | null;
  };
  readonly employee: {
    readonly id: string;
    readonly employeeCode: string;
    readonly firstName: string;
    readonly lastName: string | null;
    readonly departmentId: string | null;
    readonly locationId: string | null;
    readonly reportingManagerId: string | null;
  } | null;
  readonly roles: readonly { readonly id: string; readonly name: string }[];
  /** Technical design §10: "`/me` returns the effective permission set." */
  readonly permissions: readonly string[];
  /** 12 REQ-AB-05: when today's sign-in window closes, so the client can warn fifteen minutes ahead; exempt holders are never warned. */
  readonly accessWindow: { readonly closesInMinutes: number | null; readonly exempt: boolean };
  /** REQ-B-09: whether this person has an authenticator, must have one, and so must enrol before anything else. */
  readonly mfa: MfaSummary;
}
