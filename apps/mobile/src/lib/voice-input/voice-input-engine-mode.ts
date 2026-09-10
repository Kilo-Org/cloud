/**
 * Which engine leads a voice session and which one backs it up. The two
 * engines are primary/fallback, never one-or-the-other:
 *
 * - `device-only` — the gateway switch is off. The device recogniser is the
 *   only engine, and the gateway binding is never touched at all: no start,
 *   no stop, no permissions, not even a listener registration. A stray
 *   gateway call in this mode is the defect this replaced.
 * - `gateway-primary` — 'Use as primary' is on: the gateway leads and the
 *   device recogniser is the fallback.
 * - `device-primary` — 'Use as primary' is off but the gateway switch is on:
 *   the device recogniser leads and the gateway is the fallback.
 */
export type VoiceInputEngineMode = 'device-only' | 'gateway-primary' | 'device-primary';

export type VoiceInputEngineName = 'os' | 'gateway';

/**
 * The single error code emitted when the fallback attempt fails too. It
 * classifies to one actionable message naming both engines; the primary's
 * swallowed error and the fallback's raw error never reach the user.
 */
export const BOTH_ENGINES_FAILED_CODE = 'voice-engines-failed';

/**
 * Error codes that are not engine failures and therefore never trigger the
 * fallback: an abort the user asked for, and "no speech" — silence is
 * content, not a broken recogniser, and the other engine would only report
 * it again.
 *
 * A gateway timeout is the client's own 30 s deadline firing on a sealed
 * upload, not a broken engine. The other engine can only transcribe a fresh
 * recording, so falling back would discard the take the user already sealed
 * and silently ask for a new dictation. The timeout surfaces as its own
 * retryable state instead — the retry action the user needs.
 */
export const NON_FALLBACK_ERROR_CODES: ReadonlySet<string> = new Set([
  'aborted',
  'no-speech',
  'speech-timeout',
  'gateway-timeout',
]);

/**
 * Fallback errors that are configuration problems with their own actionable,
 * non-retryable message and CTA (pick a model, sign in, switch model, open
 * system settings). The combined `voice-engines-failed` copy is retryable and
 * would send the user to retry what no retry can fix, so the fallback's own
 * error surfaces instead — it is the one that names what went wrong and what
 * to do. `not-allowed` belongs here because a denied microphone or speech
 * permission is exactly that: retrying cannot grant it, but the settings
 * screen the CTA opens can.
 */
export const ACTIONABLE_FALLBACK_ERROR_CODES: ReadonlySet<string> = new Set([
  'gateway-no-model',
  'gateway-auth',
  'gateway-model-unavailable',
  'not-allowed',
]);

export function resolveVoiceInputEngineMode(
  enabled: boolean,
  primary: boolean
): VoiceInputEngineMode {
  if (!enabled) {
    return 'device-only';
  }
  return primary ? 'gateway-primary' : 'device-primary';
}

export function leadEngineOf(mode: VoiceInputEngineMode): VoiceInputEngineName {
  return mode === 'gateway-primary' ? 'gateway' : 'os';
}

export function fallbackEngineOf(mode: VoiceInputEngineMode): VoiceInputEngineName | null {
  if (mode === 'gateway-primary') {
    return 'os';
  }
  if (mode === 'device-primary') {
    return 'gateway';
  }
  return null;
}
