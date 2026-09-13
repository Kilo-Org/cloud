/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts the hook without a DOM or React Native. */
import { createElement } from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type SessionAutoApproveRespond, useSessionAutoApprove } from './use-session-auto-approve';

type Renderer = TestRenderer.ReactTestRenderer;

type ProbeProps = {
  enabled: boolean;
  available: boolean;
  requestId: string | null;
  respond: SessionAutoApproveRespond;
};

// Renders the hook's suppression output onto a host element so the test can
// read it after every commit. No React Native import is needed.
function Probe(props: ProbeProps) {
  const { suppressedRequestId } = useSessionAutoApprove(props);
  return createElement('AutoApproveProbe', { suppressed: suppressedRequestId });
}

function probeNode(renderer: Renderer): ReactTestInstance {
  const node = renderer.root.findAll(item => Object.is(item.type, 'AutoApproveProbe'))[0];
  if (!node) {
    throw new Error('AutoApproveProbe was not rendered');
  }
  return node;
}

function suppressed(renderer: Renderer): string | null {
  return probeNode(renderer).props.suppressed as string | null;
}

function mount(overrides?: Partial<ProbeProps>) {
  const props: ProbeProps = {
    enabled: true,
    available: true,
    requestId: 'perm-1',
    respond: vi.fn<SessionAutoApproveRespond>().mockResolvedValue('ok'),
    ...overrides,
  };
  const ref: { current: Renderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Probe, props));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return { renderer, props };
}

function rerender(renderer: Renderer, props: ProbeProps) {
  act(() => {
    renderer.update(createElement(Probe, props));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useSessionAutoApprove', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('suppresses a fresh ask and sends it once with its request id', async () => {
    const respond = vi.fn<SessionAutoApproveRespond>().mockResolvedValue('ok');
    const { renderer, props } = mount({ respond });
    await flush();

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith('perm-1');
    expect(suppressed(renderer)).toBe('perm-1');

    // A re-render with the same ask must not send a second reply.
    rerender(renderer, props);
    await flush();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(suppressed(renderer)).toBe('perm-1');
  });

  it('does not re-send an ask it has already handled', async () => {
    const respond = vi.fn<SessionAutoApproveRespond>().mockResolvedValue('ok');
    const { renderer, props } = mount({ respond });
    await flush();
    expect(respond).toHaveBeenCalledTimes(1);

    // Queue advances to a new ask, then returns to the first handled one.
    rerender(renderer, { ...props, requestId: 'perm-2' });
    await flush();
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenLastCalledWith('perm-2');

    rerender(renderer, { ...props, requestId: 'perm-1' });
    await flush();
    expect(respond).toHaveBeenCalledTimes(2);
    expect(suppressed(renderer)).toBe('perm-1');
  });

  it('un-suppresses a retryable reply so the card can render with its Retry CTA', async () => {
    const respond = vi.fn<SessionAutoApproveRespond>().mockResolvedValue('retryable');
    const { renderer } = mount({ respond });
    await flush();

    expect(respond).toHaveBeenCalledTimes(1);
    expect(suppressed(renderer)).toBeNull();

    // The failed ask is not retried automatically on the next render.
    rerender(renderer, {
      enabled: true,
      available: true,
      requestId: 'perm-1',
      respond,
    });
    await flush();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(suppressed(renderer)).toBeNull();
  });

  it('stays suppressed when the reply is terminal', async () => {
    const respond = vi.fn<SessionAutoApproveRespond>().mockResolvedValue('terminal');
    const { renderer } = mount({ respond });
    await flush();

    expect(respond).toHaveBeenCalledTimes(1);
    expect(suppressed(renderer)).toBe('perm-1');
  });

  it('un-suppresses when the responder rejects', async () => {
    const respond = vi.fn<SessionAutoApproveRespond>().mockRejectedValue(new Error('network'));
    const { renderer } = mount({ respond });
    await flush();

    expect(respond).toHaveBeenCalledTimes(1);
    expect(suppressed(renderer)).toBeNull();
  });

  it('never sends when the toggle is off', async () => {
    const respond = vi.fn<SessionAutoApproveRespond>().mockResolvedValue('ok');
    const { renderer } = mount({ enabled: false, respond });
    await flush();

    expect(respond).not.toHaveBeenCalled();
    expect(suppressed(renderer)).toBeNull();
  });

  it('never sends when the session cannot receive permissions', async () => {
    const respond = vi.fn<SessionAutoApproveRespond>().mockResolvedValue('ok');
    const { renderer } = mount({ available: false, respond });
    await flush();

    expect(respond).not.toHaveBeenCalled();
    expect(suppressed(renderer)).toBeNull();
  });

  it('never sends without a pending permission request', async () => {
    const respond = vi.fn<SessionAutoApproveRespond>().mockResolvedValue('ok');
    const { renderer } = mount({ requestId: null, respond });
    await flush();

    expect(respond).not.toHaveBeenCalled();
    expect(suppressed(renderer)).toBeNull();
  });
});
