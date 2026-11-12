import { Platform } from 'react-native';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';

import {
  isGatewayTranscriptionEnabled,
  subscribeToGatewayTranscriptionEnabled,
} from './gateway/gateway-transcription-preference';
import { gatewayVoiceInputNative } from './gateway/native-gateway-voice-input';
import { createSelectingVoiceInputNative } from './voice-input-engine-select';
import { resolveVoiceInputEngineName } from './voice-input-engine-mode';
import { createVoiceInputController } from './voice-input-controller';
import { createOsVoiceInputNative } from './os-voice-input-native';

const native = createOsVoiceInputNative(ExpoSpeechRecognitionModule, Platform);

// Exactly one engine runs per session, chosen by the live gateway switch:
// off sends every dictation to the OS recogniser, on sends every dictation
// to the Kilo gateway. The OS binding above is the `os` half of the selector.
const selectingNative = createSelectingVoiceInputNative(
  { os: native, gateway: gatewayVoiceInputNative },
  () => resolveVoiceInputEngineName(isGatewayTranscriptionEnabled())
);

export const voiceInputController = createVoiceInputController(selectingNative);

// Availability is captured once at controller construction, so a gateway
// toggle must recompute it: on an OS-unavailable device, enabling gateway
// transcription has to surface the mic button without an app restart.
subscribeToGatewayTranscriptionEnabled(() => {
  voiceInputController.refreshAvailability();
});
