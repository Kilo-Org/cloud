import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  persistFirstTranscriptionModel,
  resolveTranscriptionModelSelectionStatus,
  selectTranscriptionModel,
} from './gateway-transcription-model-selection';
import {
  readGatewayTranscriptionModel,
  writeGatewayTranscriptionModel,
} from './gateway-transcription-preference';

vi.mock('./gateway-transcription-preference', () => ({
  readGatewayTranscriptionModel: vi.fn(),
  writeGatewayTranscriptionModel: vi.fn(),
  useGatewayTranscriptionPreference: vi.fn(),
  useGatewayTranscriptionModel: vi.fn(),
  useGatewayTranscriptionModelLoaded: vi.fn(),
}));
vi.mock('@/lib/hooks/use-transcription-models', () => ({
  useTranscriptionModels: vi.fn(),
  fetchTranscriptionModels: vi.fn(),
}));

const FIRST = {
  id: 'kilo/whisper-large-v3',
  name: 'Whisper Large v3',
  variants: [],
  isPreferred: false,
};
const SECOND = {
  id: 'openai/gpt-4o-mini-transcribe',
  name: 'GPT-4o Mini Transcribe',
  variants: [],
  isPreferred: false,
};

beforeEach(() => {
  vi.mocked(readGatewayTranscriptionModel).mockReset();
  vi.mocked(writeGatewayTranscriptionModel).mockReset();
});

describe('selectTranscriptionModel', () => {
  it('selects the first catalogue model when the user never chose one', () => {
    expect(selectTranscriptionModel([FIRST, SECOND], null)).toEqual({
      id: 'kilo/whisper-large-v3',
      name: 'Whisper Large v3',
    });
  });

  it('keeps an existing choice instead of overwriting it', () => {
    const stored = { id: 'stored-model', name: 'Stored Model' };

    expect(selectTranscriptionModel([FIRST, SECOND], stored)).toBe(stored);
  });

  it('selects nothing when the catalogue is empty', () => {
    expect(selectTranscriptionModel([], null)).toBeNull();
  });
});

describe('persistFirstTranscriptionModel', () => {
  it('persists the first catalogue model when the user never chose one', () => {
    vi.mocked(readGatewayTranscriptionModel).mockReturnValue(null);

    expect(persistFirstTranscriptionModel([FIRST, SECOND])).toEqual({
      id: 'kilo/whisper-large-v3',
      name: 'Whisper Large v3',
    });
    expect(writeGatewayTranscriptionModel).toHaveBeenCalledWith({
      id: 'kilo/whisper-large-v3',
      name: 'Whisper Large v3',
    });
  });

  it('keeps and does not overwrite an existing choice', () => {
    const stored = { id: 'stored-model', name: 'Stored Model' };
    vi.mocked(readGatewayTranscriptionModel).mockReturnValue(stored);

    expect(persistFirstTranscriptionModel([FIRST, SECOND])).toBe(stored);
    expect(writeGatewayTranscriptionModel).not.toHaveBeenCalled();
  });

  it('returns null and writes nothing when the catalogue is empty', () => {
    vi.mocked(readGatewayTranscriptionModel).mockReturnValue(null);

    expect(persistFirstTranscriptionModel([])).toBeNull();
    expect(writeGatewayTranscriptionModel).not.toHaveBeenCalled();
  });

  it('returns null and writes nothing when the catalogue read failed', () => {
    // A catalogue fetch that rejects leaves the caller with an empty list;
    // persisting that must never invent a model the gateway did not offer.
    vi.mocked(readGatewayTranscriptionModel).mockReturnValue(null);

    expect(persistFirstTranscriptionModel([])).toBeNull();
    expect(writeGatewayTranscriptionModel).not.toHaveBeenCalled();
  });
});

describe('resolveTranscriptionModelSelectionStatus', () => {
  const base = {
    enabled: true,
    isLoading: false,
    isError: false,
    modelStoreLoaded: true,
    models: [FIRST, SECOND],
    stored: null,
  };

  it('is off while gateway transcription is disabled', () => {
    expect(resolveTranscriptionModelSelectionStatus({ ...base, enabled: false })).toBe('off');
  });

  it('is loading while the catalogue query is pending', () => {
    expect(resolveTranscriptionModelSelectionStatus({ ...base, isLoading: true })).toBe('loading');
  });

  it('is loading while the stored-model read is still pending', () => {
    expect(resolveTranscriptionModelSelectionStatus({ ...base, modelStoreLoaded: false })).toBe(
      'loading'
    );
  });

  it('is ready for the auto-selected first model', () => {
    expect(resolveTranscriptionModelSelectionStatus(base)).toBe('ready');
  });

  it('is ready for a stored model the catalogue still offers', () => {
    expect(
      resolveTranscriptionModelSelectionStatus({
        ...base,
        stored: { id: 'kilo/whisper-large-v3', name: 'Whisper Large v3' },
      })
    ).toBe('ready');
  });

  it('is unavailable for a stored model the catalogue dropped', () => {
    expect(
      resolveTranscriptionModelSelectionStatus({
        ...base,
        stored: { id: 'retired-model', name: 'Retired Model' },
      })
    ).toBe('unavailable');
  });

  it('is error when the load failed and nothing is cached', () => {
    expect(resolveTranscriptionModelSelectionStatus({ ...base, isError: true, models: [] })).toBe(
      'error'
    );
  });

  it('is empty when the gateway offers no models', () => {
    expect(resolveTranscriptionModelSelectionStatus({ ...base, models: [] })).toBe('empty');
  });
});
