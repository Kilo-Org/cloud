'use client';

import { Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import * as z from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StepUpSignInAgainButton } from '@/components/admin/step-up/StepUpSignInAgainButton';
import { PASSKEY_ENROLLMENT_CODE_LENGTH } from '@/lib/auth/passkey-enrollment-codes';

/** The one route that emails the code, mints registration options and verifies the attestation. */
const REGISTER_ROUTE = '/api/auth/passkey/register';

const CODE_INPUT_ID = 'passkey-enrollment-code';
const CODE_HINT_ID = 'passkey-enrollment-code-hint';
const CODE_ERROR_ID = 'passkey-enrollment-code-error';

/** A code the server emailed for this browser session. */
export type SentEmailCode = {
  emailCodeId: string;
  email: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
};

/** Why a step of the enrollment did not go on. */
export type EnrollmentRefusal =
  | { kind: 'reauth_required' }
  | { kind: 'code_invalid'; attemptsLeft: number }
  | { kind: 'code_expired' }
  | { kind: 'locked'; retryAt: number }
  | { kind: 'cooldown'; retryAt: number }
  | { kind: 'undeliverable' }
  | { kind: 'delivery_failed' }
  | { kind: 'failed' };

/**
 * Where the enrollment stands. `sending` keeps the code it replaces, so a
 * refused resend returns to that code instead of losing it.
 */
export type PasskeyEnrollmentPhase =
  | { step: 'idle' }
  | { step: 'sending'; previous: SentEmailCode | null }
  | { step: 'enter_code'; sent: SentEmailCode; problem: EnrollmentRefusal | null }
  | { step: 'registering'; sent: SentEmailCode }
  | { step: 'refused'; refusal: EnrollmentRefusal };

const refusalSchema = z.object({
  error: z.string(),
  attemptsLeft: z.number().int().nonnegative().optional(),
  retryAfterSeconds: z.number().int().positive().optional(),
});

const sentSchema = z.object({
  emailCodeId: z.string(),
  expiresInSeconds: z.number().int().positive(),
  email: z.string(),
});

const optionsSchema = z.object({
  challengeId: z.string(),
  options: z.custom<PublicKeyCredentialCreationOptionsJSON>(
    value => typeof value === 'object' && value !== null
  ),
});

async function postRegister(body: unknown): Promise<Response> {
  return fetch(REGISTER_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function refusalOf(response: Response): Promise<EnrollmentRefusal> {
  const parsed = refusalSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) return { kind: 'failed' };
  const { error, attemptsLeft, retryAfterSeconds } = parsed.data;
  switch (error) {
    case 'REAUTH_REQUIRED':
      return { kind: 'reauth_required' };
    case 'EMAIL_CODE_INVALID':
      return attemptsLeft === undefined
        ? { kind: 'failed' }
        : { kind: 'code_invalid', attemptsLeft };
    case 'EMAIL_CODE_REQUIRED':
    case 'EMAIL_CODE_EXPIRED':
      return { kind: 'code_expired' };
    case 'EMAIL_CODE_LOCKED':
      return retryAfterSeconds === undefined
        ? { kind: 'failed' }
        : { kind: 'locked', retryAt: Date.now() + retryAfterSeconds * 1000 };
    case 'EMAIL_CODE_COOLDOWN':
      return retryAfterSeconds === undefined
        ? { kind: 'failed' }
        : { kind: 'cooldown', retryAt: Date.now() + retryAfterSeconds * 1000 };
    case 'EMAIL_UNDELIVERABLE':
      return { kind: 'undeliverable' };
    case 'EMAIL_DELIVERY_FAILED':
      return { kind: 'delivery_failed' };
    default:
      return { kind: 'failed' };
  }
}

export type SendCodeResult =
  | { ok: true; sent: SentEmailCode }
  | { ok: false; refusal: EnrollmentRefusal };

/** Asks the server to email a code for this browser session. */
export async function sendPasskeyEnrollmentCode(): Promise<SendCodeResult> {
  try {
    const response = await postRegister({ action: 'send_code' });
    if (!response.ok) return { ok: false, refusal: await refusalOf(response) };
    const parsed = sentSchema.safeParse(await response.json());
    if (!parsed.success) return { ok: false, refusal: { kind: 'failed' } };
    return {
      ok: true,
      sent: {
        emailCodeId: parsed.data.emailCodeId,
        email: parsed.data.email,
        expiresAt: Date.now() + parsed.data.expiresInSeconds * 1000,
      },
    };
  } catch {
    return { ok: false, refusal: { kind: 'failed' } };
  }
}

export type RegistrationResult =
  | { kind: 'registered' }
  | { kind: 'cancelled' }
  | { kind: 'refused'; refusal: EnrollmentRefusal };

/**
 * Registers a passkey with an emailed code: mint options server-side, run the
 * browser ceremony, then let the server verify the attestation against the
 * challenge it stored. The row only exists once the server has accepted it.
 */
export async function registerPasskeyWithEmailCode(emailCode: {
  emailCodeId: string;
  code: string;
}): Promise<RegistrationResult> {
  try {
    const optionsResponse = await postRegister({ action: 'options', emailCode });
    if (!optionsResponse.ok) {
      return { kind: 'refused', refusal: await refusalOf(optionsResponse) };
    }
    const minted = optionsSchema.safeParse(await optionsResponse.json());
    if (!minted.success) return { kind: 'refused', refusal: { kind: 'failed' } };

    let attestation: RegistrationResponseJSON;
    try {
      attestation = await startRegistration({ optionsJSON: minted.data.options });
    } catch (error) {
      // @simplewebauthn/browser throws NotAllowedError when the person
      // dismisses the sheet and AbortError on a timeout. No row was written.
      const name = error instanceof Error ? error.name : '';
      return name === 'NotAllowedError' || name === 'AbortError'
        ? { kind: 'cancelled' }
        : { kind: 'refused', refusal: { kind: 'failed' } };
    }

    const verifyResponse = await postRegister({
      action: 'verify',
      challengeId: minted.data.challengeId,
      response: attestation,
      emailCode,
    });
    if (!verifyResponse.ok) {
      return { kind: 'refused', refusal: await refusalOf(verifyResponse) };
    }
    return { kind: 'registered' };
  } catch {
    return { kind: 'refused', refusal: { kind: 'failed' } };
  }
}

/** A refusal that ends the enrollment rather than the current code attempt. */
function endsEnrollment(refusal: EnrollmentRefusal): boolean {
  return refusal.kind === 'reauth_required' || refusal.kind === 'undeliverable';
}

export type PasskeyEnrollment = {
  phase: PasskeyEnrollmentPhase;
  code: string;
  setCode: (code: string) => void;
  /** Opens the enrollment. A code from this page that is still live is reused. */
  start: () => void;
  sendNewCode: () => void;
  submitCode: () => void;
  cancel: () => void;
};

/**
 * The browser passkey enrollment: email a code, take it from the person, then
 * run the passkey ceremony with it. Every async step owns the phase only while
 * it is the latest step; `cancel` or a newer step drops its result.
 */
export function usePasskeyEnrollment(onEnrolled: () => Promise<unknown> | void): PasskeyEnrollment {
  const [phase, setPhaseState] = useState<PasskeyEnrollmentPhase>({ step: 'idle' });
  const [code, setCode] = useState('');
  const phaseRef = useRef<PasskeyEnrollmentPhase>(phase);
  const ownerRef = useRef(0);
  const lastSentRef = useRef<SentEmailCode | null>(null);
  const onEnrolledRef = useRef(onEnrolled);
  useEffect(() => {
    onEnrolledRef.current = onEnrolled;
  });
  useEffect(
    () => () => {
      ownerRef.current += 1;
    },
    []
  );

  const setPhase = useCallback((next: PasskeyEnrollmentPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const takeOwnership = useCallback(() => {
    ownerRef.current += 1;
    const owner = ownerRef.current;
    return () => owner === ownerRef.current;
  }, []);

  const send = useCallback(
    async (previous: SentEmailCode | null) => {
      const owns = takeOwnership();
      setPhase({ step: 'sending', previous });
      const result = await sendPasskeyEnrollmentCode();
      if (!owns()) return;
      if (result.ok) {
        lastSentRef.current = result.sent;
        setCode('');
        setPhase({ step: 'enter_code', sent: result.sent, problem: null });
        return;
      }
      if (previous && previous.expiresAt > Date.now() && !endsEnrollment(result.refusal)) {
        setPhase({ step: 'enter_code', sent: previous, problem: result.refusal });
        return;
      }
      setPhase({ step: 'refused', refusal: result.refusal });
    },
    [setPhase, takeOwnership]
  );

  const start = useCallback(() => {
    if (phaseRef.current.step !== 'idle') return;
    const live = lastSentRef.current;
    if (live && live.expiresAt > Date.now()) {
      setCode('');
      setPhase({ step: 'enter_code', sent: live, problem: null });
      return;
    }
    void send(null);
  }, [send, setPhase]);

  const sendNewCode = useCallback(() => {
    const current = phaseRef.current;
    if (current.step === 'enter_code') void send(current.sent);
    else if (current.step === 'refused' && !endsEnrollment(current.refusal)) void send(null);
  }, [send]);

  const submitCode = useCallback(() => {
    const current = phaseRef.current;
    if (current.step !== 'enter_code' || code.length !== PASSKEY_ENROLLMENT_CODE_LENGTH) return;
    if (current.problem?.kind === 'locked' && current.problem.retryAt > Date.now()) return;
    const { sent } = current;
    const owns = takeOwnership();
    setPhase({ step: 'registering', sent });
    void registerPasskeyWithEmailCode({ emailCodeId: sent.emailCodeId, code }).then(result => {
      if (!owns()) return;
      switch (result.kind) {
        case 'registered':
          lastSentRef.current = null;
          setCode('');
          setPhase({ step: 'idle' });
          void onEnrolledRef.current();
          return;
        case 'cancelled':
          setCode('');
          setPhase({ step: 'idle' });
          return;
        case 'refused':
          if (endsEnrollment(result.refusal)) {
            setPhase({ step: 'refused', refusal: result.refusal });
            return;
          }
          if (result.refusal.kind === 'code_expired' || result.refusal.kind === 'locked') {
            lastSentRef.current = null;
          }
          setPhase({ step: 'enter_code', sent, problem: result.refusal });
      }
    });
  }, [code, setPhase, takeOwnership]);

  const cancel = useCallback(() => {
    if (phaseRef.current.step === 'registering') return;
    takeOwnership();
    setCode('');
    setPhase({ step: 'idle' });
  }, [setPhase, takeOwnership]);

  return { phase, code, setCode, start, sendNewCode, submitCode, cancel };
}

/** Renders again each second while `until` is in the future, so a wait counts down. */
function useSecondTicks(until: number | null): void {
  const [, setTicks] = useState(0);
  useEffect(() => {
    if (until === null || until <= Date.now()) return;
    const timer = setInterval(() => {
      setTicks(ticks => ticks + 1);
      if (Date.now() >= until) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [until]);
}

function waitText(retryAt: number, now: number): string {
  const seconds = Math.max(1, Math.ceil((retryAt - now) / 1000));
  if (seconds < 60) return seconds === 1 ? '1 second' : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

export const PASSKEY_ENROLLMENT_REAUTH_MESSAGE =
  'Sign in again before adding a passkey. Signing out signs you out of every browser.';

function refusalMessage(refusal: EnrollmentRefusal, now: number): string {
  switch (refusal.kind) {
    case 'reauth_required':
      return PASSKEY_ENROLLMENT_REAUTH_MESSAGE;
    case 'code_invalid':
      return `That code is not correct. ${refusal.attemptsLeft} ${
        refusal.attemptsLeft === 1 ? 'try' : 'tries'
      } left.`;
    case 'code_expired':
      return 'That code expired or was already used. Send a new code.';
    case 'locked':
      return refusal.retryAt > now
        ? `Too many incorrect codes. You can send a new code in ${waitText(refusal.retryAt, now)}.`
        : 'Too many incorrect codes. Send a new code.';
    case 'cooldown':
      return refusal.retryAt > now
        ? `A code was sent a moment ago. You can send a new code in ${waitText(refusal.retryAt, now)}.`
        : 'You can send a new code now.';
    case 'undeliverable':
      return 'We cannot deliver email to your account address, so we cannot send a code.';
    case 'delivery_failed':
      return 'We could not send the code email. Try again.';
    case 'failed':
      return 'Could not add a passkey. Try again.';
  }
}

function waitingUntil(refusal: EnrollmentRefusal | null): number | null {
  return refusal?.kind === 'locked' || refusal?.kind === 'cooldown' ? refusal.retryAt : null;
}

/**
 * The enrollment steps after "Add a passkey": sending, code entry, the passkey
 * sheet, and every refusal. `Description` renders the step's description, so a
 * dialog can pass its own description element.
 */
export function PasskeyEnrollmentSteps({
  enrollment,
  Description,
}: {
  enrollment: PasskeyEnrollment;
  Description: React.ComponentType<{ children: React.ReactNode }>;
}) {
  const { phase, code, setCode, sendNewCode, submitCode, cancel } = enrollment;
  const problem =
    phase.step === 'enter_code' ? phase.problem : phase.step === 'refused' ? phase.refusal : null;
  const waitUntil = waitingUntil(problem);
  useSecondTicks(waitUntil);
  const now = Date.now();
  const waiting = waitUntil !== null && waitUntil > now;

  if (phase.step === 'idle') return null;

  if (phase.step === 'sending') {
    return (
      <div className="space-y-4">
        <Description>Confirm it is you with a code from your email.</Description>
        <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Sending a code to your email…
        </p>
      </div>
    );
  }

  if (phase.step === 'refused') {
    const { refusal } = phase;
    return (
      <div className="space-y-4">
        <Description>Confirm it is you with a code from your email.</Description>
        <p role="alert" className="text-destructive text-sm">
          {refusalMessage(refusal, now)}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={cancel}>
            Cancel
          </Button>
          {refusal.kind === 'reauth_required' ? (
            <StepUpSignInAgainButton size="default" />
          ) : refusal.kind === 'undeliverable' ? null : refusal.kind === 'locked' ||
            refusal.kind === 'cooldown' ? (
            <Button onClick={sendNewCode} disabled={waiting}>
              Send a new code
            </Button>
          ) : (
            <Button onClick={sendNewCode}>Try again</Button>
          )}
        </div>
      </div>
    );
  }

  const registering = phase.step === 'registering';
  const { sent } = phase;
  const minutesLeft = Math.max(1, Math.ceil((sent.expiresAt - now) / 60_000));
  const locked = problem?.kind === 'locked';
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitCode();
  };

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <Description>
        We sent a {PASSKEY_ENROLLMENT_CODE_LENGTH}-digit code to {sent.email}. It expires in{' '}
        {minutesLeft === 1 ? '1 minute' : `${minutesLeft} minutes`}.
      </Description>
      <div className="flex flex-col gap-2">
        <Label htmlFor={CODE_INPUT_ID}>Code</Label>
        <Input
          id={CODE_INPUT_ID}
          value={code}
          onChange={event =>
            setCode(event.target.value.replace(/\D/g, '').slice(0, PASSKEY_ENROLLMENT_CODE_LENGTH))
          }
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          maxLength={PASSKEY_ENROLLMENT_CODE_LENGTH}
          disabled={registering || locked}
          aria-describedby={problem ? CODE_ERROR_ID : CODE_HINT_ID}
          aria-invalid={problem?.kind === 'code_invalid'}
          className="font-mono tracking-[0.4em]"
        />
        {problem ? (
          <p id={CODE_ERROR_ID} role="alert" className="text-destructive text-sm">
            {refusalMessage(problem, now)}
          </p>
        ) : (
          <p id={CODE_HINT_ID} className="text-muted-foreground text-sm">
            {registering
              ? 'Follow the prompt from your browser to create the passkey.'
              : 'After the code, your browser asks you to create the passkey.'}
          </p>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={cancel} disabled={registering}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={sendNewCode}
          disabled={registering || waiting}
        >
          Send a new code
        </Button>
        <Button
          type="submit"
          disabled={registering || locked || code.length !== PASSKEY_ENROLLMENT_CODE_LENGTH}
        >
          {registering ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" />
              Waiting for your passkey…
            </>
          ) : (
            'Add passkey'
          )}
        </Button>
      </div>
    </form>
  );
}
