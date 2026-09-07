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
