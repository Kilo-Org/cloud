/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React trees under vitest (same pattern as use-history-backfill.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { type AgentMode } from './mode-normalize';
import { useSessionConfigSync } from './use-session-config-sync';

type R = TestRenderer.ReactTestRenderer;
type Inputs = Parameters<typeof useSessionConfigSync>[0];

/**
 * A freshly spawned remote session: the ingest row carries no mode yet and the
 * CLI has not reported a `sessionConfig` either. This is the state in which the
 * mobile auto-send used to fall back to `code`.
 */
function spawnedRemoteInputs(overrides: Partial<Inputs> = {}): Inputs {
  return {
    activeSessionType: 'remote',
    fetchedData: { mode: null, model: null, variant: null },
    sessionConfig: null,
    modelOptions: [],
    selectedModel: '',
    selectedVariant: '',
    ...overrides,
  };
}

/** Records the mode the hook hands the send path on every render. */
function ModeProbe({ inputs, seen }: { inputs: Inputs; seen: { current: AgentMode } }) {
  seen.current = useSessionConfigSync(inputs).currentMode;
  return null;
}

async function mountProbe(inputs: Inputs): Promise<{ renderer: R; seen: { current: AgentMode } }> {
  const seen: { current: AgentMode } = { current: 'code' };
  const ref: { current: R | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(createElement(ModeProbe, { inputs, seen }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return { renderer, seen };
}

async function updateProbe(
  renderer: R,
  inputs: Inputs,
  seen: { current: AgentMode }
): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    renderer.update(createElement(ModeProbe, { inputs, seen }));
  });
}

describe('useSessionConfigSync mode seeding', () => {
  it('seeds the spawn-chosen custom slug when the session reports no mode', async () => {
    const { seen } = await mountProbe(spawnedRemoteInputs({ spawnedMode: 'reviewer' }));

    expect(seen.current).toBe('reviewer');
  });

  it('falls back to code when the spawn passed no mode', async () => {
    const { seen } = await mountProbe(spawnedRemoteInputs());

    expect(seen.current).toBe('code');
  });

  it('lets a live sessionConfig mode win over the seed', async () => {
    const { renderer, seen } = await mountProbe(spawnedRemoteInputs({ spawnedMode: 'reviewer' }));

    await updateProbe(
      renderer,
      spawnedRemoteInputs({
        spawnedMode: 'reviewer',
        sessionConfig: { mode: 'debug', model: null, variant: null },
      }),
      seen
    );

    expect(seen.current).toBe('debug');
  });

  it('lets a stored session mode win over the seed', async () => {
    const { seen } = await mountProbe(
      spawnedRemoteInputs({
        spawnedMode: 'reviewer',
        fetchedData: { mode: 'plan', model: null, variant: null },
      })
    );

    expect(seen.current).toBe('plan');
  });
});
