import { describe, expect, it } from 'vitest';
import { type inferRouterInputs, type RootRouter } from '@kilocode/trpc';

import {
  buildLocalSessionCreateRequest,
  type BuildLocalSessionCreateRequestInput,
  type LocalSessionCreateAgentSelection,
  type LocalSessionCreateModelSelection,
} from './local-session-create-request';

type RouterInputs = inferRouterInputs<RootRouter>;

const FENCE = {
  runtimeId: '11111111-1111-4111-8111-111111111111',
  connectionId: 'cli-connection-1',
} as const;

const AGENT: LocalSessionCreateAgentSelection = { slug: 'build', name: 'Build' };

const MODEL_PINNED: LocalSessionCreateModelSelection = {
  providerID: 'kilo',
  modelID: 'claude-opus-4-7',
  variant: 'max',
};

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';

function makeInput(
  overrides: Partial<BuildLocalSessionCreateRequestInput> = {}
): BuildLocalSessionCreateRequestInput {
  return {
    fence: FENCE,
    catalog: {
      protocolVersion: 1,
      defaultAgent: 'build',
      agents: [AGENT],
      models: {
        protocolVersion: 1,
        providers: [
          {
            id: 'kilo',
            models: [{ id: 'claude-opus-4-7', variants: ['max', 'min'] }],
          },
        ],
        truncated: false,
      },
    },
    selectedAgentSlug: 'build',
    selectedModel: MODEL_PINNED,
    prompt: 'Build me a thing',
    requestId: REQUEST_ID,
    ...overrides,
  };
}

describe('buildLocalSessionCreateRequest', () => {
  it('returns a strict-shape request that mirrors the tRPC createAndRun input', () => {
    const built = buildLocalSessionCreateRequest(makeInput());
    expect(built).toEqual({
      fence: FENCE,
      request: {
        protocolVersion: 1,
        requestId: REQUEST_ID,
        prompt: 'Build me a thing',
        model: { providerID: 'kilo', modelID: 'claude-opus-4-7' },
        variant: 'max',
        agent: 'build',
      },
    });
  });

  it('trims the prompt before the length check and the wire payload', () => {
    const built = buildLocalSessionCreateRequest(makeInput({ prompt: '   trimmed   ' }));
    expect(built.request.prompt).toBe('trimmed');
  });

  it('rejects a prompt that is empty after trimming', () => {
    expect(() => buildLocalSessionCreateRequest(makeInput({ prompt: '   ' }))).toThrow();
  });

  it('rejects a prompt that is one character too long', () => {
    const tooLong = 'a'.repeat(32_768 + 1);
    expect(() => buildLocalSessionCreateRequest(makeInput({ prompt: tooLong }))).toThrow();
  });

  it('accepts a prompt at the exact 32,768-character boundary', () => {
    const at = 'a'.repeat(32_768);
    const built = buildLocalSessionCreateRequest(makeInput({ prompt: at }));
    expect(built.request.prompt.length).toBe(32_768);
  });

  it('rejects a prompt that is empty before trimming', () => {
    expect(() => buildLocalSessionCreateRequest(makeInput({ prompt: '' }))).toThrow();
  });

  it('rejects when the requestId is not a UUID', () => {
    expect(() => buildLocalSessionCreateRequest(makeInput({ requestId: 'not-a-uuid' }))).toThrow();
  });

  it('rejects when the fence is missing or partial', () => {
    expect(() =>
      buildLocalSessionCreateRequest(makeInput({ fence: { ...FENCE, runtimeId: '' } }))
    ).toThrow();
    expect(() =>
      buildLocalSessionCreateRequest(makeInput({ fence: { ...FENCE, connectionId: '' } }))
    ).toThrow();
  });

  it('rejects when the catalog is not a usable shape (no agents, no models, missing default agent)', () => {
    const noAgents = makeInput({
      catalog: { ...makeInput().catalog, agents: [] },
    });
    expect(() => buildLocalSessionCreateRequest(noAgents)).toThrow();

    const noModels = makeInput({
      catalog: {
        ...makeInput().catalog,
        models: { protocolVersion: 1, providers: [], truncated: false },
      },
    });
    expect(() => buildLocalSessionCreateRequest(noModels)).toThrow();

    const unknownAgent = makeInput({ selectedAgentSlug: 'rogue' });
    expect(() => buildLocalSessionCreateRequest(unknownAgent)).toThrow();
  });

  it('rejects when the selected model is not present in the catalog', () => {
    const missingModel = makeInput({
      selectedModel: { providerID: 'kilo', modelID: 'not-in-catalog', variant: 'max' },
    });
    expect(() => buildLocalSessionCreateRequest(missingModel)).toThrow();
  });

  it('rejects when the selected variant is not one of the model variants', () => {
    const missingVariant = makeInput({
      selectedModel: {
        providerID: 'kilo',
        modelID: 'claude-opus-4-7',
        variant: 'unknown-variant',
      },
    });
    expect(() => buildLocalSessionCreateRequest(missingVariant)).toThrow();
  });

  it('omits the variant key from the wire payload when the model has no variant', () => {
    const noVariant = makeInput({
      selectedModel: { providerID: 'kilo', modelID: 'claude-opus-4-7', variant: '' },
    });
    const built = buildLocalSessionCreateRequest(noVariant);
    expect('variant' in built.request).toBe(false);
  });

  it('does not include an attachments or images field on the request shape', () => {
    const built = buildLocalSessionCreateRequest(makeInput());
    const keys = Object.keys(built.request).toSorted();
    expect(keys).toEqual(
      ['agent', 'model', 'prompt', 'protocolVersion', 'requestId', 'variant'].toSorted()
    );
    expect('attachments' in built.request).toBe(false);
    expect('images' in built.request).toBe(false);
  });

  it('uses the supplied requestId verbatim and does not reach for any UUID generator', () => {
    const built = buildLocalSessionCreateRequest(makeInput());
    expect(built.request.requestId).toBe(REQUEST_ID);
  });

  it('treats inputs that violate the type contract as unknown at the parser seam', () => {
    const malformed: unknown = { fence: null, catalog: null, prompt: null, requestId: null };
    expect(() =>
      buildLocalSessionCreateRequest(malformed as BuildLocalSessionCreateRequestInput)
    ).toThrow();
  });

  it('exposes a typed return value that is structurally compatible with the tRPC RouterInputs createAndRun input', () => {
    const built = buildLocalSessionCreateRequest(makeInput());
    const _typed: RouterInputs['localRuntimeControl']['createAndRun'] = built;
    void _typed;
  });
});
