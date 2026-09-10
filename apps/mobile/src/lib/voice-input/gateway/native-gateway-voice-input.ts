import { AudioModule, AudioQuality, RecordingPresets, setAudioModeAsync } from 'expo-audio';
import * as SecureStore from 'expo-secure-store';

import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { fetchTranscriptionModels } from '@/lib/hooks/use-transcription-models';
import { ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

import { createGatewayVoiceInputEngine, type GatewayRecorder } from './gateway-voice-input-engine';
import {
  type GatewayTranscriptionModel,
  readGatewayTranscriptionModel,
} from './gateway-transcription-preference';

const HIGH_QUALITY = RecordingPresets.HIGH_QUALITY;

/** The organization scope the voice flow reads and uploads under; null is personal. */
async function readStoredOrganizationId(): Promise<string | null> {
  return await SecureStore.getItemAsync(ORGANIZATION_STORAGE_KEY);
}

/**
 * The model the gateway engine transcribes with: the stored choice, else the
 * first model the gateway catalogue offers, else null. A catalogue that
 * cannot be reached reads as "no model", which surfaces the actionable picker
 * message on the first dictation instead of an upload that must fail.
 */
export async function resolveGatewayTranscriptionModelId(): Promise<GatewayTranscriptionModel | null> {
  const stored = readGatewayTranscriptionModel();
  if (stored !== null) {
    return stored;
  }
  try {
    // Scope the catalogue read to the selected organization: the upload that
    // follows carries the same organization header, so an unscoped default
    // could pick a model the scoped upload then rejects.
    const organizationId = await readStoredOrganizationId();
    const models = await fetchTranscriptionModels(organizationId ?? undefined);
    return models[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The recorder is constructed with the preset's common keys only and receives
 * the full preset at prepare time: expo-audio installs a cross-platform shim
 * on `AudioRecorder.prototype.prepareToRecordAsync` (its internal
 * `createRecordingOptions`, not exported) that flattens the shared
 * `RecordingPresets` shape — common keys plus the active platform's `ios` or
 * `android` record — before the native call, identically on both platforms.
 * The one constructor asymmetry is `audioQuality`: the iOS deserializer
 * requires it top-level when constructing `AudioRecorder` (an iOS-only
 * field with no Android equivalent — the Android record converter ignores the
 * unknown key). Its value only configures the transient pre-prepare recorder;
 * the prepare call rebuilds the recorder from the preset's real platform
 * record.
 */
// The type is intentionally inferred: the native constructor takes the
// flattened options shape, whose top-level `audioQuality` the exported
// `RecordingOptions` type keeps nested under `ios` only.
const RECORDER_BOOTSTRAP_OPTIONS = {
  extension: HIGH_QUALITY.extension,
  sampleRate: HIGH_QUALITY.sampleRate,
  numberOfChannels: HIGH_QUALITY.numberOfChannels,
  bitRate: HIGH_QUALITY.bitRate,
  isMeteringEnabled: HIGH_QUALITY.isMeteringEnabled ?? false,
  audioQuality: AudioQuality.MAX,
};

/**
 * The gateway half of the voice-input native binding: expo-audio's recorder,
 * the transcription client, and the persisted preference/auth reads, wired
 * into the engine. expo-audio 57 exports recording only through the
 * `useAudioRecorder` hook, but the hook is a thin wrapper over the
 * constructible `AudioModule.AudioRecorder` shared object — so the engine gets
 * an imperative factory here (with explicit `release()`) and no React provider
 * is needed at the app root.
 */
export const gatewayVoiceInputNative = createGatewayVoiceInputEngine({
  setAudioMode: async mode => {
    // expo-audio's iOS validation (AudioUtils.validateAudioMode) throws
    // InvalidAudioModeException when allowsRecording is set while the stored
    // playsInSilentMode is false — and the native default is false. Pair the
    // two here so the gateway recorder can actually record on iOS; the field
    // is iOS-only and Android ignores it.
    await setAudioModeAsync({ ...mode, playsInSilentMode: true });
  },
  createRecorder: (): GatewayRecorder => {
    const recorder = new AudioModule.AudioRecorder(RECORDER_BOOTSTRAP_OPTIONS);
    return {
      get uri(): string | null {
        return recorder.uri;
      },
      // The shimmed `prepareToRecordAsync` flattens the nested preset into the
      // active platform's native options shape before the native call.
      prepareToRecordAsync: async () => {
        await recorder.prepareToRecordAsync(HIGH_QUALITY);
      },
      record: () => {
        recorder.record();
      },
      stop: async () => {
        await recorder.stop();
      },
      release: () => {
        recorder.release();
      },
    };
  },
  readModelId: resolveGatewayTranscriptionModelId,
  readAuthToken: getAuthTokenForRequest,
  readOrganizationId: readStoredOrganizationId,
});
