import { type VoiceNetworkConsent } from './voice-network-consent';

export type VoiceInputRecognitionMode = 'on-device' | 'network' | 'blocked';

/**
 * Resolves the recognition mode for a start attempt (P1-I-68a). On-device is
 * preferred: when on-device recognition is possible the mode is `on-device`
 * regardless of consent. `supportsOnDevice` is the refined check — the
 * recognition service must be available AND the resolved language must have
 * an offline model installed (`isVoiceInputLanguageInstalledOnDevice`), since
 * `requiresOnDeviceRecognition` for a model-less language fails on every
 * start. Network recognition is allowed only after the per-user consent is
 * `granted`; otherwise the attempt is `blocked` until the user decides.
 */
export function resolveVoiceInputRecognitionMode(
  supportsOnDevice: boolean,
  consent: VoiceNetworkConsent
): VoiceInputRecognitionMode {
  if (supportsOnDevice) {
    return 'on-device';
  }
  if (consent === 'granted') {
    return 'network';
  }
  return 'blocked';
}

/**
 * The transcription state a privacy review may claim. `gateway` means every
 * dictation is sent through the Kilo gateway; `on-device` means dictation
 * stays local; `online` means dictation needs the per-user network consent
 * and sends the recording to the OS recognition provider.
 */
export type VoiceTranscriptionReviewMode = 'gateway' | 'on-device' | 'online';

/**
 * Resolve what the privacy review's voice-transcription row states, from the
 * same inputs a start attempt uses (use-voice-input-actions.ts): the gateway
 * switch owns the session while it is on, and an on-device claim needs the
 * refined check — the recognition service must be available AND the resolved
 * language must have its offline model installed. `serviceSupportsOnDevice`
 * is the service-level value alone; `languageInstalledOnDevice` is the
 * per-language refinement, which the mic treats as installed when its probe
 * fails so a possible start is never blocked.
 */
export function resolveVoiceTranscriptionReviewMode({
  gatewayTranscriptionEnabled,
  serviceSupportsOnDevice,
  languageInstalledOnDevice,
}: {
  gatewayTranscriptionEnabled: boolean;
  serviceSupportsOnDevice: boolean;
  languageInstalledOnDevice: boolean;
}): VoiceTranscriptionReviewMode {
  if (gatewayTranscriptionEnabled) {
    return 'gateway';
  }
  if (serviceSupportsOnDevice && languageInstalledOnDevice) {
    return 'on-device';
  }
  return 'online';
}
