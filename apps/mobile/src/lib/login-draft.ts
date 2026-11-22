import * as SecureStore from '@/lib/auth/secure-store';
import { z } from 'zod';

import { chainSave } from '@/lib/hooks/save-chain';
import {
  LOGIN_DRAFT_RECORD_KEY,
  LOGIN_EMAIL_DRAFT_KEY,
  LOGIN_SSO_RECOVERY_DRAFT_KEY,
} from '@/lib/storage-keys';
import { captureTelemetry } from '@/lib/telemetry/error-sink';

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
 * Whether this process holds an attempt of its own to write back: an address
 * the person typed, a held draft a restore returned, or an invite they
 * followed. A mount that unmounted before any of those holds nothing: writing
 * its blanks could only replace the draft its read could not see, or the
 * tombstone that retired the last attempt.
 */
let writeOpen = false;

/** How many times a retirement write is tried before it is reported. */
const RETIREMENT_ATTEMPTS = 2;

/** A retirement this process still owes the keychain, retried at the next safe point. */
let retirementPending = false;

/** Write the record with nothing in front of it: callers hold the key's chain. */
function writeRecordLocked(record: StoredLoginDraft): Promise<void> {
  return SecureStore.setItemAsync(LOGIN_DRAFT_RECORD_KEY, JSON.stringify(record));
}

/** Write the record on the one chain, so a persist can never land after a retirement. */
function writeRecord(record: StoredLoginDraft): Promise<void> {
  return chainSave(LOGIN_DRAFT_RECORD_KEY, () => writeRecordLocked(record));
}

/**
 * What one read of the durable record learned. `absent` only when the keychain
 * answered that there is no record: a read that failed and a value this build
 * cannot parse are `unknown`, because neither is evidence that nothing is
 * stored.
 */
type RecordRead =
  | { readonly kind: 'held'; readonly email: string; readonly ssoRecovery: SsoRecoveryDraft | null }
  | { readonly kind: 'absent' | 'retired' | 'unknown' };

async function readRecord(): Promise<RecordRead> {
  try {
    const raw = await SecureStore.getItemAsync(LOGIN_DRAFT_RECORD_KEY);
    if (raw === null) {
      return { kind: 'absent' };
    }
    const parsed = storedLoginDraftSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return { kind: 'unknown' };
    }
    if (parsed.data.state === 'retired') {
      return { kind: 'retired' };
    }
    const ssoRecovery = parsed.data.ssoRecovery;
    return {
      kind: 'held',
      email: parsed.data.email,
      ssoRecovery:
        ssoRecovery === undefined
          ? null
          : { email: ssoRecovery.email, ssoOrganizationId: ssoRecovery.ssoOrganizationId },
    };
  } catch {
    return { kind: 'unknown' };
  }
}

/** Start an attempt from what the person typed: explicit typing always reopens one. */
export function beginLoginEmail(email: string): void {
  writeOpen = true;
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
    /* An invite the person followed is an attempt to keep, like a typed
       address: it must survive the reload a language change performs. */
    writeOpen = true;
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
 * A retired attempt writes nothing, and neither does a process that never
 * opened an attempt: a mount that unmounted before it typed, restored a held
 * draft or took an invite holds nothing of its own, and writing its blanks
 * could only destroy the draft its read could not see or revive the attempt a
 * retirement ended.
 */
export async function persistLoginDrafts(): Promise<void> {
  if (phase.kind === 'retired' || !writeOpen) {
    return;
  }
  await writeRecord({
    version: 2,
    state: 'held',
    email: phase.email,
    ...(phase.ssoRecovery === null ? {} : { ssoRecovery: phase.ssoRecovery }),
  });
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
  if (phase.kind === 'retired') {
    /* The screen about to draw is signed out, which is the last safe point for
       a retirement this process still owes. Fire it after answering. */
    if (retirementPending) {
      void retireLoginAttempt();
    }
    return { email: '', ssoRecovery: null };
  }
  const record = await readRecord();
  /* The writer opens only for a read that learned what the screen shows: an
     absent record has nothing to lose, and a held one is adopted below. A read
     that failed, or a tombstone, leaves it closed — the unmount write then
     cannot replace the draft this read could not see, or revive the attempt the
     retirement ended. */
  if (record.kind === 'absent' || record.kind === 'held') {
    writeOpen = true;
  }
  const held = record.kind === 'held' ? record : null;
  /* A held draft is what the screen shows next: an untyped memory that then
     persists on unmount must write it, not the blanks it began with. */
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
async function writeRetirementLocked(attemptsLeft: number): Promise<void> {
  try {
    await writeRecordLocked({ version: 2, state: 'retired' });
  } catch (error) {
    if (attemptsLeft <= 1) {
      throw error;
    }
    await writeRetirementLocked(attemptsLeft - 1);
  }
}

/**
 * Report a retirement that could not be written. The tags follow the app's
 * subsystem pattern and name the operation only: neither the record key nor its
 * contents — an address, a recovery banner — is attached.
 */
function reportRetirementFailure(error: unknown): void {
  captureTelemetry({
    error,
    level: 'warning',
    tags: { 'error.subsystem': 'login_draft', 'error.operation': 'retire' },
    fingerprint: ['login-draft-retirement', 'write'],
  });
}

/**
 * Retire the attempt after a successful sign-in.
 *
 * Retirement is a required part of completing the sign-in, not a cleanup: a
 * record left `held` on disk is restored by the next cold start, which is the
 * bug this lives for. Memory retires first, so this process never shows the
 * attempt again whatever the keychain does; the write is retried, and a failure
 * is reported and kept as an obligation instead of failing the caller.
 *
 * A signed-in session is not undone by a keychain write, so this never rejects.
 * The sign-out path runs it again, still inside its auth-transition queue and
 * before the signed-out login screen can restore a draft, so the held record is
 * usually gone before anyone could see it.
 */
export async function retireLoginAttempt(): Promise<void> {
  /* Memory retirement never waits on the keychain: whatever the write does, the
     signed-out screen must not see the attempt this sign-in ended. */
  phase = { kind: 'retired' };
  try {
    /* The decision is made inside the key's chain, after any queued persist has
       landed. Only a record the keychain says is absent costs no write: a read
       that failed, or a value this build cannot parse, is not evidence that
       nothing is stored, and skipping the tombstone would leave the held copy
       for the next cold start. */
    await chainSave(LOGIN_DRAFT_RECORD_KEY, async () => {
      const record = await readRecord();
      if (!retirementPending && (record.kind === 'absent' || record.kind === 'retired')) {
        return;
      }
      await writeRetirementLocked(RETIREMENT_ATTEMPTS);
    });
    retirementPending = false;
  } catch (error) {
    retirementPending = true;
    reportRetirementFailure(error);
  }
}

// ── Test-only helpers ───────────────────────────────────────────────────────

/** Test-only: a fresh process, with nothing typed and no retirement. */
export function _resetLoginDraftForTests(): void {
  phase = { kind: 'attempt', email: '', ssoRecovery: null };
  legacyCleaned = false;
  writeOpen = false;
  retirementPending = false;
}
