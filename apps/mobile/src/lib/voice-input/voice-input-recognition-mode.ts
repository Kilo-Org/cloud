import { type VoiceNetworkConsent } from './voice-network-consent';

export type VoiceInputRecognitionMode = 'on-device' | 'network' | 'blocked';

/**
 * Resolves the recognition mode for a start attempt (P1-I-68a). On-device is
 * preferred: when it is supported the mode is `on-device` regardless of
 * consent. Network recognition is allowed only after the per-user consent is
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
