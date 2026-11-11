import { type Platform } from 'react-native';
import {
  type ExpoSpeechRecognitionModule,
  type ExpoSpeechRecognitionResultEvent,
} from 'expo-speech-recognition';

import { type VoiceInputNative, type VoiceInputNativeEvent } from './voice-input-controller';
import { dropIosRepeatedFinal } from './voice-input-ios-final';

const ANDROID_CONTINUOUS_MIN_API_LEVEL = 33;
type SpeechModule = typeof ExpoSpeechRecognitionModule;
type NativePlatform = Pick<typeof Platform, 'OS' | 'Version'>;

function supportsContinuousRecognition(platform: NativePlatform): boolean {
  if (platform.OS === 'ios') {
    return true;
  }
  if (platform.OS !== 'android') {
    return false;
  }
  const version = Number(platform.Version);
  return Number.isFinite(version) && version >= ANDROID_CONTINUOUS_MIN_API_LEVEL;
}

/** The OS binding's listeners accept only events stamped by the native run that start requested. */
export function createOsVoiceInputNative(
  module: SpeechModule,
  platform: NativePlatform
): VoiceInputNative {
  let sessionId = 0;

  return {
    addListener<K extends keyof VoiceInputNativeEvent>(
      event: K,
      listener: (payload: VoiceInputNativeEvent[K]) => void
    ) {
      if (event === 'transcribing' || event === 'progress') {
        // Only the gateway has a queued transcription phase.
        return { remove: (): void => undefined };
      }
      if (event === 'result') {
        const receive = listener as (payload: ExpoSpeechRecognitionResultEvent) => void;
        const resultListener = platform.OS === 'ios' ? dropIosRepeatedFinal(receive) : receive;
        return module.addListener('kiloEvent', envelope => {
          // Filter before iOS deduplication so an old final cannot suppress the new run's first final.
          if (envelope.sessionId === sessionId && envelope.event === 'result') {
            resultListener(envelope.payload);
          }
        });
      }
      return module.addListener('kiloEvent', envelope => {
        if (envelope.sessionId !== sessionId || envelope.event !== event) {
          return;
        }
        // Equality above narrows the runtime event to K; TypeScript cannot correlate a generic K with this union.
        listener(envelope.payload as VoiceInputNativeEvent[K]);
      });
    },
    getPermissions: async () => {
      const result = await module.getPermissionsAsync();
      return result;
    },
    requestPermissions: async () => {
      const result = await module.requestPermissionsAsync();
      return result;
    },
    isRecognitionAvailable: () => module.isRecognitionAvailable(),
    supportsContinuousRecognition: () => supportsContinuousRecognition(platform),
    supportsOnDevice: () => module.supportsOnDeviceRecognition(),
    start: options => {
      sessionId += 1;
      module.start({
        continuous: options.continuous,
        interimResults: options.interimResults,
        kiloSessionId: sessionId,
        lang: options.lang,
        maxAlternatives: options.maxAlternatives,
        requiresOnDeviceRecognition: options.requiresOnDeviceRecognition,
      });
    },
    stop: () => {
      module.stop();
    },
    abort: () => {
      module.abort();
    },
  };
}
