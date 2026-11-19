/**
 * Which engine runs a voice session. The user picks exactly one in
 * Preferences, and there is no fallback: the chosen engine owns the session
 * for its whole life.
 */
export type VoiceInputEngineName = 'os' | 'gateway';

/** Map the gateway-transcription preference onto the engine that runs. */
export function resolveVoiceInputEngineName(
  gatewayTranscriptionEnabled: boolean
): VoiceInputEngineName {
  return gatewayTranscriptionEnabled ? 'gateway' : 'os';
}
