/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as use-force-update.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it } from 'vitest';

import { useRestoreErrorHold } from '@/lib/hooks/use-restore-error-hold';

type HoldProps = {
  hasRestoreError: boolean;
  hidden: boolean;
  isSigningOut: boolean;
};

function Harness(props: HoldProps): React.ReactElement {
  const holding = useRestoreErrorHold(props);
  return createElement('surface', { held: holding ? 'held' : 'released' });
}

function mount(props: HoldProps): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Harness, props));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function held(renderer: TestRenderer.ReactTestRenderer): boolean {
  const surfaces = renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'surface'
  );
  if (surfaces.length !== 1) {
    throw new Error(`expected exactly one surface host, found ${surfaces.length}`);
  }
  return surfaces[0]?.props.held === 'held';
}

async function update(renderer: TestRenderer.ReactTestRenderer, props: HoldProps): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    renderer.update(createElement(Harness, props));
  });
}

const settledError = { hasRestoreError: true, hidden: false, isSigningOut: false };

describe('useRestoreErrorHold', () => {
  beforeEach(() => {
    // React 19 requires the act environment flag before `act` supports
    // layout effects (same setup as animated-splash-overlay.mounted.test.tsx).
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('holds the settled restore-error surface', () => {
    const renderer = mount(settledError);
    expect(held(renderer)).toBe(true);
    renderer.unmount();
  });

  it('keeps the surface through the hidden retried bootstrap, releases at the reveal', async () => {
    const renderer = mount(settledError);
    expect(held(renderer)).toBe(true);

    // Retry succeeded: restoreFailed cleared, the gate hides the tree while
    // the token publish, user fetch, and consent check run.
    await update(renderer, { hasRestoreError: false, hidden: true, isSigningOut: false });
    expect(held(renderer)).toBe(true);

    // The gate reveals the tree: the surface may swap inside this paint.
    await update(renderer, { hasRestoreError: false, hidden: false, isSigningOut: false });
    expect(held(renderer)).toBe(false);
    renderer.unmount();
  });

  it('releases immediately when sign-out starts the escape hatch', async () => {
    const renderer = mount(settledError);
    expect(held(renderer)).toBe(true);

    await update(renderer, { hasRestoreError: false, hidden: true, isSigningOut: true });
    expect(held(renderer)).toBe(false);
    renderer.unmount();
  });

  it('holds again when a retried read re-settles the error', async () => {
    const renderer = mount(settledError);
    await update(renderer, { hasRestoreError: false, hidden: false, isSigningOut: false });
    expect(held(renderer)).toBe(false);

    await update(renderer, { hasRestoreError: true, hidden: false, isSigningOut: false });
    expect(held(renderer)).toBe(true);
    renderer.unmount();
  });

  it('never holds on a boot that never saw the restore error', async () => {
    const renderer = mount({ hasRestoreError: false, hidden: true, isSigningOut: false });
    expect(held(renderer)).toBe(false);

    await update(renderer, { hasRestoreError: false, hidden: false, isSigningOut: false });
    expect(held(renderer)).toBe(false);
    renderer.unmount();
  });
});
