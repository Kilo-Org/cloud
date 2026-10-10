import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import { type StoredChatBackend } from './backend-store';
import {
  backendTargetId,
  decodeBackendTarget,
  localTargetId,
  resolveChatTarget,
} from './backend-target';
import { localModelOptions, requiresBackendDisclosure } from './backend-model-options';

const first: StoredChatBackend = {
  id: 'server-one',
  revision: 1,
  name: 'One',
  baseUrl: 'https://one.example/v1',
  apiKind: 'chat_completions',
  apiKey: '',
  headers: {},
  models: [{ id: 'vendor/model:latest', name: 'Model', tools: false, images: false }],
  allowLocalHttp: false,
};
const modelId = 'vendor/model:latest';

describe('persisted chat backend targets', () => {
  it('distinguishes the same upstream model on two configured backends', () => {
    const second = { ...first, id: 'server-two', baseUrl: 'https://two.example/v1' };
    const profiles = [first, second];
    const target = resolveChatTarget(backendTargetId(second, modelId), profiles);
    expect(target.kind).toBe('custom');
    if (target.kind !== 'custom') {
      throw new Error('Expected a custom target');
    }
    expect(target.backend.baseUrl).toBe('https://two.example/v1');
    expect(target.modelId).toBe(modelId);
  });

  it('refuses an edited endpoint instead of redirecting a stored conversation', () => {
    const target = backendTargetId(first, modelId);
    expect(() => resolveChatTarget(target, [{ ...first, revision: 2 }])).toThrow(
      expect.objectContaining({ problem: 'staleBackend' })
    );
  });

  it('refuses a deleted backend rather than falling back to the gateway', () => {
    expect(() => resolveChatTarget(backendTargetId(first, modelId), [])).toThrow(
      expect.objectContaining({ problem: 'deletedBackend' })
    );
  });

  it('refuses a removed model instead of selecting another configured model', () => {
    const target = backendTargetId(first, modelId);
    expect(() => resolveChatTarget(target, [{ ...first, models: [] }])).toThrow(
      expect.objectContaining({ problem: 'missingModel' })
    );
  });

  it.each([
    'backend:server:0:model',
    'backend:server:1:%XX',
    'backend:server:1:',
    'backend:server:9007199254740992:model',
  ])('refuses malformed custom target %s', target => {
    expect(() => decodeBackendTarget(target)).toThrow(
      expect.objectContaining({ problem: 'invalidTarget' })
    );
  });

  it('requires context disclosure across backend identities and endpoint revisions', () => {
    const target = backendTargetId(first, modelId);
    expect(requiresBackendDisclosure('kilo/default', target)).toBe(true);
    expect(requiresBackendDisclosure(target, 'kilo/default')).toBe(true);
    expect(
      requiresBackendDisclosure(target, backendTargetId({ ...first, revision: 2 }, modelId))
    ).toBe(true);
    expect(requiresBackendDisclosure(target, backendTargetId(first, 'another-model'))).toBe(false);
    expect(requiresBackendDisclosure('kilo/one', 'kilo/two')).toBe(false);
  });

  it.each([
    ['local:apple', { provider: 'apple', modelId: 'system' }],
    ['local:android', { provider: 'android', modelId: 'system' }],
    [
      localTargetId('gguf', 'models/Qwen 3:4b.gguf'),
      { provider: 'gguf', modelId: 'models/Qwen 3:4b.gguf' },
    ],
  ])('resolves on-device target %s without consulting backends', (id, expected) => {
    expect(resolveChatTarget(id, [])).toEqual({ kind: 'local', ...expected });
  });

  it.each([
    'local:',
    'local:ios',
    'local:apple:extra',
    'local:gguf:',
    'local:gguf:%XX',
    'local:gguf:a b',
  ])('refuses malformed on-device target %s', target => {
    expect(() => resolveChatTarget(target, [first])).toThrow(
      expect.objectContaining({ problem: 'invalidTarget' })
    );
  });

  it('requires context disclosure between remote and each on-device model', () => {
    const custom = backendTargetId(first, modelId);
    const firstFile = localTargetId('gguf', 'one.gguf');
    expect(requiresBackendDisclosure('kilo/default', 'local:apple')).toBe(true);
    expect(requiresBackendDisclosure('local:apple', 'kilo/default')).toBe(true);
    expect(requiresBackendDisclosure(custom, 'local:apple')).toBe(true);
    expect(requiresBackendDisclosure('local:apple', 'local:android')).toBe(true);
    expect(requiresBackendDisclosure(firstFile, localTargetId('gguf', 'two.gguf'))).toBe(true);
    expect(requiresBackendDisclosure('local:apple', 'local:apple')).toBe(false);
    expect(requiresBackendDisclosure(firstFile, firstFile)).toBe(false);
  });

  it('offers an on-device model only while its provider reports it available', () => {
    const availability = {
      modelId: 'apple-system-language-model',
      contextWindow: 4096,
      maxOutputTokens: 4096,
      systemInstructions: true,
    };
    const status = {
      provider: 'apple',
      targetId: 'local:apple',
      nameKey: 'modelChat.localModels.apple',
    } as const;
    expect(localModelOptions([{ ...status, availability: undefined }], i18n.t)).toEqual([]);
    expect(
      localModelOptions(
        [
          {
            ...status,
            availability: { ...availability, status: 'unavailable', reason: 'model_not_ready' },
          },
        ],
        i18n.t
      )
    ).toEqual([]);
    expect(
      localModelOptions(
        [{ ...status, availability: { ...availability, status: 'available' } }],
        i18n.t
      )
    ).toMatchObject([
      { id: 'local:apple', name: 'Apple Intelligence (on device)', contextWindow: 4096 },
    ]);
  });
});
