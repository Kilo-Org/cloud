import { Platform } from 'react-native';
import {
  type ExpoSpeechRecognitionErrorEvent,
  ExpoSpeechRecognitionModule,
  type ExpoSpeechRecognitionResultEvent,
} from 'expo-speech-recognition';

import {
  createVoiceInputController,
  type VoiceInputNative,
  type VoiceInputNativeEvent,
} from './voice-input-controller';

const ANDROID_CONTINUOUS_MIN_API_LEVEL = 33;

function isAndroidApiLevelAtLeast(level: number): boolean {
  if (Platform.OS !== 'android') {
    return false;
  }
  const version = Platform.Version;
  if (typeof version === 'number') {
    return version >= level;
  }
  const parsed = Number.parseInt(String(version), 10);
  return Number.isFinite(parsed) ? parsed >= level : false;
}

function supportsContinuousRecognition(): boolean {
  if (Platform.OS === 'ios') {
    return true;
  }
  return isAndroidApiLevelAtLeast(ANDROID_CONTINUOUS_MIN_API_LEVEL);
}

type ExpoSpeechRecognitionModuleType = typeof ExpoSpeechRecognitionModule;

function bindListener<K extends keyof VoiceInputNativeEvent>(
  module: ExpoSpeechRecognitionModuleType,
  event: K,
  listener: (event: VoiceInputNativeEvent[K]) => void
): { remove(): void } {
  // The native module's addListener is generic over its full event map, so
  // when called with our narrower event union the listener parameter is
  // widened to an intersection of every native listener type. Per-event
  // dispatch below instantiates the generic at each known event name so the
  // listener type is concrete and the assignment is sound: each branch
  // forwards a listener whose payload type matches the native event exactly.
  if (event === 'start') {
    return module.addListener('start', listener as (event: null) => void);
  }
  if (event === 'result') {
    return module.addListener(
      'result',
      listener as (event: ExpoSpeechRecognitionResultEvent) => void
    );
  }
  if (event === 'nomatch') {
    return module.addListener('nomatch', listener as (event: null) => void);
  }
  if (event === 'error') {
    return module.addListener(
      'error',
      listener as (event: ExpoSpeechRecognitionErrorEvent) => void
    );
  }
  return module.addListener('end', listener as (event: null) => void);
}

const native: VoiceInputNative = {
  addListener(event, listener) {
    return bindListener(ExpoSpeechRecognitionModule, event, listener);
  },
  getPermissions: async () => {
    const result = await ExpoSpeechRecognitionModule.getPermissionsAsync();
    return result;
  },
  requestPermissions: async () => {
    const result = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    return result;
  },
  isRecognitionAvailable: () => ExpoSpeechRecognitionModule.isRecognitionAvailable(),
  supportsContinuousRecognition,
  start: options => {
    ExpoSpeechRecognitionModule.start({
      continuous: options.continuous,
      interimResults: options.interimResults,
      lang: options.lang,
      maxAlternatives: options.maxAlternatives,
    });
  },
  stop: () => {
    ExpoSpeechRecognitionModule.stop();
  },
  abort: () => {
    ExpoSpeechRecognitionModule.abort();
  },
};

export const voiceInputController = createVoiceInputController(native);
