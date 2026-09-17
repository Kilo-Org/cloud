// The iOS half registers the session's `NSUserActivity` through expo-router's
// `Head` and nothing else: `Head` reads the `<title>`/`<meta>` children and
// calls the native `ExpoHead.createActivity` with `isEligibleForHandoff` only
// when an `expo:handoff` meta is present, using the `og:url` meta as the
// advertised `webpageURL`. There is no iOS build in this worktree, so this test
// is the contract proof: it captures the exact children `Head` is handed, which
// is all the native side ever sees. Without the `expo:handoff` child the
// activity is never registered and the session screen silently advertises
// nothing.

import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionHandoffAdvertiser } from './session-handoff.ios';

const head = vi.hoisted(() => ({
  children: undefined as ReactNode,
  renders: 0,
}));

vi.mock('expo-router/head', () => ({
  default: (props: { children?: ReactNode }) => {
    head.renders += 1;
    head.children = props.children;
    return null;
  },
}));

const SESSION_ID = 'ses_1';
const ANCHOR_ID = 'msg_42';
const SESSION_TITLE = 'Fix the flaky test';
const SESSION_URL = 'https://app.kilo.ai/cloud/sessions/ses_1?at=msg_42';

type MetaChild = {
  readonly type: string;
  readonly props: Record<string, unknown>;
};

/** The `<title>`/`<meta>` elements the component handed to `Head`. */
function headChildren(): MetaChild[] {
  const raw: unknown = head.children;
  const children: unknown[] = Array.isArray(raw) ? raw : [];
  return children
    .filter(
      (child): child is { type: unknown; props: unknown } =>
        typeof child === 'object' && child !== null && 'props' in child && 'type' in child
    )
    .map(child => ({
      type: String(child.type),
      props: child.props as Record<string, unknown>,
    }));
}

function headMeta(property: string): MetaChild | undefined {
  return headChildren().find(child => child.type === 'meta' && child.props.property === property);
}

function renderAdvertiser({
  sessionId = SESSION_ID,
  anchorMessageId = ANCHOR_ID,
  title = SESSION_TITLE,
}: {
  sessionId?: string;
  anchorMessageId?: string | null;
  title?: string;
} = {}): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SessionHandoffAdvertiser, { sessionId, anchorMessageId, title })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('SessionHandoffAdvertiser (iOS)', () => {
  beforeEach(() => {
    head.children = undefined;
    head.renders = 0;
  });

  it('hands Head the link, the position and the handoff opt-in', () => {
    renderAdvertiser();

    expect(head.renders).toBe(1);
    expect(headChildren().find(child => child.type === 'title')?.props.children).toBe(
      SESSION_TITLE
    );
    expect(headMeta('og:url')?.props.content).toBe(SESSION_URL);
    expect(headMeta('og:description')?.props.content).toBe(SESSION_TITLE);
    // Head turns the activity on only for a truthy `expo:handoff`.
    expect(headMeta('expo:handoff')?.props.content).toBe('true');
  });

  it('advertises the session top when there is no anchor', () => {
    renderAdvertiser({ anchorMessageId: null });

    expect(headMeta('og:url')?.props.content).toBe('https://app.kilo.ai/cloud/sessions/ses_1');
  });

  it('advertises nothing for a session with no id', () => {
    const renderer = renderAdvertiser({ sessionId: '' });

    expect(head.renders).toBe(0);
    expect(renderer.toJSON()).toBeNull();
  });
});
