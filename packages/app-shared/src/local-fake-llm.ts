/**
 * Model ids served by the local fake LLM (`FAKE_LLM_URL`).
 *
 * The web gateway routes these ids to the local fake in development, and the
 * Cloud Agent e2e harness (`services/cloud-agent-next/test/e2e/fake-llm-core.ts`)
 * implements the catalogue they name. Both sides import this module, so an id
 * rename cannot leave one of them with a stale copy.
 */

/** Chat catalogue id. The Cloud Agent driver addresses it as `kilo/<id>`. */
export const LOCAL_FAKE_DETERMINISTIC_MODEL_ID = 'fake-deterministic';

/**
 * Speech-to-text catalogue ids. `fake-transcribe-broken` answers its
 * transcription request with 404 so the non-retryable unhappy state is
 * provable without an upstream key.
 */
export const LOCAL_FAKE_TRANSCRIPTION_MODEL_IDS = [
  'fake-transcribe',
  'fake-transcribe-broken',
] as const;

export type LocalFakeTranscriptionModelId = (typeof LOCAL_FAKE_TRANSCRIPTION_MODEL_IDS)[number];
