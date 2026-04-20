import { db } from '@/lib/drizzle';
import { email_verification_state, type EmailVerificationState } from '@kilocode/db/schema';
import type {
  EmailVerificationOverrideState,
  EmailVerificationResult,
} from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import { checkEmailWithNeverBounce, type NeverBounceCheckOutcome } from './email-neverbounce';

const BLOCKED_RESULTS = new Set<EmailVerificationResult>(['invalid', 'disposable']);

export type EmailVerificationDecision = 'allow' | 'block' | 'unknown';
export type EmailVerificationDecisionSource = 'override' | 'verification' | 'none';

export type EmailVerificationDecisionResult = {
  email: string;
  decision: EmailVerificationDecision;
  source: EmailVerificationDecisionSource;
  row?: EmailVerificationState;
};

export type EmailVerificationOverrideActor = {
  userId: string;
};

export function canonicalizeEmailVerificationEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function getEmailVerificationDecisionFromRow(
  email: string,
  row?: EmailVerificationState
): EmailVerificationDecisionResult {
  if (!row) {
    return {
      email,
      decision: 'unknown',
      source: 'none',
    };
  }

  if (row.override_state === 'force_allow') {
    return {
      email,
      decision: 'allow',
      source: 'override',
      row,
    };
  }

  if (row.override_state === 'force_block') {
    return {
      email,
      decision: 'block',
      source: 'override',
      row,
    };
  }

  if (!row.verification_result) {
    return {
      email,
      decision: 'unknown',
      source: 'none',
      row,
    };
  }

  return {
    email,
    decision: BLOCKED_RESULTS.has(row.verification_result) ? 'block' : 'allow',
    source: 'verification',
    row,
  };
}

export async function getStoredEmailVerification(
  email: string
): Promise<EmailVerificationState | undefined> {
  const canonicalEmail = canonicalizeEmailVerificationEmail(email);
  return await db.query.email_verification_state.findFirst({
    where: eq(email_verification_state.email, canonicalEmail),
  });
}

export async function getEmailVerificationDecision(
  email: string
): Promise<EmailVerificationDecisionResult> {
  const canonicalEmail = canonicalizeEmailVerificationEmail(email);
  const row = await getStoredEmailVerification(canonicalEmail);
  return getEmailVerificationDecisionFromRow(canonicalEmail, row);
}

async function upsertVerificationCheckResult(
  email: string,
  outcome: Extract<NeverBounceCheckOutcome, { kind: 'checked' }>
): Promise<EmailVerificationState> {
  const checkedAt = new Date().toISOString();
  const [row] = await db
    .insert(email_verification_state)
    .values({
      email,
      verification_result: outcome.result,
      checked_at: checkedAt,
    })
    .onConflictDoUpdate({
      target: email_verification_state.email,
      set: {
        verification_result: outcome.result,
        checked_at: checkedAt,
      },
    })
    .returning();

  if (!row) {
    throw new Error(`Failed to upsert email verification state for ${email}`);
  }

  return row;
}

export async function refreshEmailVerification(
  email: string
): Promise<EmailVerificationDecisionResult & { outcome: NeverBounceCheckOutcome }> {
  const canonicalEmail = canonicalizeEmailVerificationEmail(email);
  const existingRow = await getStoredEmailVerification(canonicalEmail);
  const outcome = await checkEmailWithNeverBounce(canonicalEmail);

  if (outcome.kind === 'checked') {
    const row = await upsertVerificationCheckResult(canonicalEmail, outcome);
    return {
      ...getEmailVerificationDecisionFromRow(canonicalEmail, row),
      outcome,
    };
  }

  if (existingRow) {
    return {
      ...getEmailVerificationDecisionFromRow(canonicalEmail, existingRow),
      outcome,
    };
  }

  return {
    email: canonicalEmail,
    decision: outcome.shouldSend ? 'allow' : 'block',
    source: 'none',
    outcome,
  };
}

export async function ensureKnownEmailVerification(
  email: string
): Promise<EmailVerificationDecisionResult & { outcome?: NeverBounceCheckOutcome }> {
  const canonicalEmail = canonicalizeEmailVerificationEmail(email);
  const currentDecision = await getEmailVerificationDecision(canonicalEmail);

  if (currentDecision.decision !== 'unknown') {
    return currentDecision;
  }

  return await refreshEmailVerification(canonicalEmail);
}

export async function setEmailVerificationOverride(
  email: string,
  overrideState: EmailVerificationOverrideState,
  actor: EmailVerificationOverrideActor,
  reason: string | null
): Promise<EmailVerificationState> {
  const canonicalEmail = canonicalizeEmailVerificationEmail(email);
  const overrideAt = new Date().toISOString();
  const [row] = await db
    .insert(email_verification_state)
    .values({
      email: canonicalEmail,
      override_state: overrideState,
      override_reason: reason,
      override_actor_user_id: actor.userId,
      override_at: overrideAt,
    })
    .onConflictDoUpdate({
      target: email_verification_state.email,
      set: {
        override_state: overrideState,
        override_reason: reason,
        override_actor_user_id: actor.userId,
        override_at: overrideAt,
      },
    })
    .returning();

  if (!row) {
    throw new Error(`Failed to set email verification override for ${canonicalEmail}`);
  }

  return row;
}

export async function clearEmailVerificationOverride(
  email: string
): Promise<EmailVerificationState | undefined> {
  const canonicalEmail = canonicalizeEmailVerificationEmail(email);
  const [row] = await db
    .update(email_verification_state)
    .set({
      override_state: null,
      override_reason: null,
      override_actor_user_id: null,
      override_at: null,
    })
    .where(eq(email_verification_state.email, canonicalEmail))
    .returning();

  return row;
}
