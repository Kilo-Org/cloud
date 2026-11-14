import * as SecureStore from '@/lib/auth/secure-store';
import { z } from 'zod';

import { chainSave } from '@/lib/hooks/save-chain';
import {
  LOGIN_DRAFT_RECORD_KEY,
  LOGIN_EMAIL_DRAFT_KEY,
  LOGIN_SSO_RECOVERY_DRAFT_KEY,
} from '@/lib/storage-keys';

export type SsoRecoveryDraft = { email: string; ssoOrganizationId: string | undefined };

const ssoRecoveryDraftSchema = z.object({
  email: z.string(),
  ssoOrganizationId: z.string().optional(),
});

/**
 * The one durable record: the copy a reload reads, or the tombstone that keeps
 * it from coming back. Retirement is a write, so it survives a restart and no
 * delete can fail it away.
 */
const storedLoginDraftSchema = z.discriminatedUnion('state', [
  z.object({
    version: z.literal(2),
    state: z.literal('held'),
    email: z.string(),
    ssoRecovery: ssoRecoveryDraftSchema.optional(),
  }),
  z.object({ version: z.literal(2), state: z.literal('retired') }),
]);

/** The one durable record: the copy a reload reads, or the tombstone that keeps it from coming back. */
type StoredLoginDraft = z.infer<typeof storedLoginDraftSchema>;

/** One sign-in attempt: what the form holds, or the retirement the sign-in left behind. */
type LoginDraftPhase =
  | {
      readonly kind: 'attempt';
      readonly email: string;
      readonly ssoRecovery: SsoRecoveryDraft | null;
    }
  | { readonly kind: 'retired' };

let phase: LoginDraftPhase = { kind: 'attempt', email: '', ssoRecovery: null };

/** The pre-upgrade drafts are deleted once per process and never read as values. */
let legacyCleaned = false;

/**
 * Whether a restoration has run in this process, and whether the person has
 * typed since. A mount that unmounts before either is uninitialized memory: it
 * must not write its blanks over the record a restart is about to restore.
 */
let restored = false;
let edited = false;

/** How many times a retirement write is tried before the completion fails. */
const RETIREMENT_ATTEMPTS = 2;

/** Write the record on the one chain, so a persist can never land after a retirement. */
function writeRecord(record: StoredLoginDraft): Promise<void> {
  return chainSave(LOGIN_DRAFT_RECORD_KEY, async () => {
    await SecureStore.setItemAsync(LOGIN_DRAFT_RECORD_KEY, JSON.stringify(record));
  });
}

/** Start an attempt from what the person typed: explicit typing always reopens one. */
export function beginLoginEmail(email: string): void {
  edited = true;
  phase = {
    kind: 'attempt',
    email,
    ssoRecovery: phase.kind === 'attempt' ? phase.ssoRecovery : null,
  };
}

/** Seed the address a restore handed the form. A passive write, so it never reopens a retired attempt. */
export function holdLoginEmail(email: string): void {
  if (phase.kind === 'retired') {
    return;
  }
  phase = { kind: 'attempt', email, ssoRecovery: phase.ssoRecovery };
}

/**
 * Hold the SSO-recovery banner. A banner the person arrived with is an invite
 * they followed, so it reopens a retired attempt; clearing one is passive and
 * never does.
 */
export function holdSsoRecovery(recovery: SsoRecoveryDraft | null): void {
  if (recovery !== null) {
    phase = {
      kind: 'attempt',
      email: phase.kind === 'attempt' ? phase.email : recovery.email,
      ssoRecovery: recovery,
    };
    return;
  }
  if (phase.kind === 'retired') {
    return;
  }
  if (phase.ssoRecovery === null) {
    return;
  }
  phase = { kind: 'attempt', email: phase.email, ssoRecovery: null };
}

/**
 * Write the drafts to disk so they survive an RTL language reload.
 *
 * A retired attempt writes nothing, and neither does an uninitialized process:
 * a mount that unmounts before its restore ran holds no attempt at all, so
 * writing it would blank the record the next mount restores.
 */
export async function persistLoginDrafts(): Promise<void> {
  if (phase.kind === 'retired' || (!restored && !edited)) {
    return;
  }
  await writeRecord({
    version: 2,
    state: 'held',
    email: phase.email,
    ...(phase.ssoRecovery === null ? {} : { ssoRecovery: phase.ssoRecovery }),
  });
}

/** The record's held values, or null when it holds none this build can read. */
async function readRecord(): Promise<{
  email: string;
  ssoRecovery: SsoRecoveryDraft | null;
} | null> {
  try {
    const raw = await SecureStore.getItemAsync(LOGIN_DRAFT_RECORD_KEY);
    if (raw === null) {
      return null;
    }
    const parsed = storedLoginDraftSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.state !== 'held') {
      return null;
    }
    const ssoRecovery = parsed.data.ssoRecovery;
    return {
      email: parsed.data.email,
      ssoRecovery:
        ssoRecovery === undefined
          ? null
          : { email: ssoRecovery.email, ssoOrganizationId: ssoRecovery.ssoOrganizationId },
    };
  } catch {
    return null;
  }
}

/**
 * Delete what the previous build stored under two keys. It is never restored:
 * the build cannot know whether it belongs to a live attempt, and a cold start
 * has an empty field anyway.
 */
async function deleteLegacyDrafts(): Promise<void> {
  if (legacyCleaned) {
    return;
  }
  legacyCleaned = true;
  await Promise.all([
    SecureStore.deleteItemAsync(LOGIN_EMAIL_DRAFT_KEY).catch(() => undefined),
    SecureStore.deleteItemAsync(LOGIN_SSO_RECOVERY_DRAFT_KEY).catch(() => undefined),
  ]);
}

/**
 * Read the drafts on login mount. A draft the form is holding in memory wins
 * over the stored copy: a remount inside the same app process, such as the one
 * a language change causes, must not drop what the person already typed. A
 * retired attempt restores nothing, whatever the record says.
 */
export async function restoreLoginDrafts(): Promise<{
  email: string;
  ssoRecovery: SsoRecoveryDraft | null;
}> {
  await deleteLegacyDrafts();
  restored = true;
  if (phase.kind === 'retired') {
    return { email: '', ssoRecovery: null };
  }
  const held = await readRecord();
  /* Restoration initializes the attempt: an untyped memory that then persists
     on unmount must write what the person was shown, not the blanks it began
     with. */
  if (held !== null && phase.email.length === 0 && phase.ssoRecovery === null) {
    phase = { kind: 'attempt', email: held.email, ssoRecovery: held.ssoRecovery };
  }
  return {
    email: phase.email.length > 0 ? phase.email : (held?.email ?? ''),
    ssoRecovery: phase.ssoRecovery ?? held?.ssoRecovery ?? null,
  };
}

/**
 * Write the tombstone, trying again once. The retry, and the failure it
 * finally raises, are what make retirement a required step: a record left
 * `held` is restored by the next cold start.
 */
async function writeRetirement(attemptsLeft: number): Promise<void> {
  try {
    await writeRecord({ version: 2, state: 'retired' });
  } catch (error) {
    if (attemptsLeft <= 1) {
      throw error;
    }
    await writeRetirement(attemptsLeft - 1);
  }
}

/**
 * Retire the attempt after a successful sign-in: memory first, then the
 * tombstone.
 *
 * Retirement is a required part of completing the sign-in, not a cleanup: a
 * record left `held` on disk is restored by the next cold start, which is the
 * bug this lives for. So the write is retried, and one that still fails
 * rejects, so the completion can be retried instead of quietly leaving the old
 * copy restorable. Memory stays retired meanwhile.
 */
export async function endLoginAttempt(): Promise<void> {
  phase = { kind: 'retired' };
  await writeRetirement(RETIREMENT_ATTEMPTS);
}

// ── Test-only helpers ───────────────────────────────────────────────────────

/** Test-only: a fresh process, with nothing typed and no retirement. */
export function _resetLoginDraftForTests(): void {
  phase = { kind: 'attempt', email: '', ssoRecovery: null };
  legacyCleaned = false;
  restored = false;
  edited = false;
}
