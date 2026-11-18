import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
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
    sessionId: 'k1',
    ...overrides,
  };
}

/** What the hook hands the send path, and the picker's own setter. */
type Probe = { current: AgentMode; setMode: (mode: AgentMode) => void };

/** Records the mode the hook hands the send path on every render. */
function ModeProbe({ inputs, seen }: { inputs: Inputs; seen: Probe }) {
  const sync = useSessionConfigSync(inputs);
  seen.current = sync.currentMode;
  seen.setMode = sync.setCurrentMode;
  return null;
}

async function mountProbe(inputs: Inputs): Promise<{ renderer: R; seen: Probe }> {
  const seen: Probe = { current: 'code', setMode: () => undefined };
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

async function updateProbe(renderer: R, inputs: Inputs, seen: Probe): Promise<void> {
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

  it('keeps a mode picked before the session row lands', async () => {
    /* The composer is live on a cached transcript while the session row is still
       in flight, so a person can pick a mode before anything tells the composer
       what the session's own mode is. That pick is their answer: the row that
       lands afterwards is about the session as it was before they answered, so
       it may not replace it. */
    const { renderer, seen } = await mountProbe(
      spawnedRemoteInputs({ fetchedData: null, sessionConfig: null })
    );

    await act(async () => {
      seen.setMode('debug');
      await Promise.resolve();
    });
    expect(seen.current).toBe('debug');

    await updateProbe(
      renderer,
      spawnedRemoteInputs({ sessionConfig: { mode: 'code', model: null, variant: null } }),
      seen
    );

    expect(seen.current).toBe('debug');
  });

  it('does not carry a pick made in one session into another', async () => {
    const { renderer, seen } = await mountProbe(
      spawnedRemoteInputs({ fetchedData: null, sessionConfig: null })
    );

    await act(async () => {
      seen.setMode('debug');
      await Promise.resolve();
    });

    await updateProbe(
      renderer,
      spawnedRemoteInputs({
        sessionId: 'k2',
        sessionConfig: { mode: 'plan', model: null, variant: null },
      }),
      seen
    );

    expect(seen.current).toBe('plan');
  });
});
