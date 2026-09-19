// One advertiser serves both platforms: the link and the position come from the
// shared `buildSessionHandoff`, iOS receives them through `Head`, and Android's
// launcher entry point is the one mechanism the other platform lacks. These
// tests pin both capabilities of that single component — the children `Head` is
// handed (all the iOS native side ever sees) and the publish/clear lifecycle of
// the launcher module, whose absence on iOS leaves the same render inert.

import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionHandoffAdvertiser } from './session-handoff';

const launcher = vi.hoisted(() => ({
  publishSession: vi.fn(),
  clearSession: vi.fn(),
}));

// The Android launcher module (`modules/kilo-session-handoff`) is the half iOS
// does not have. Flipping this switch is the only platform difference in the
// component under test.
const capability = vi.hoisted(() => ({ launcherEntryPoint: true }));

const head = vi.hoisted(() => ({
  children: undefined as ReactNode,
  renders: 0,
}));

// Captures the focus-effect callback (and the cleanup it returns) so a test can
// simulate the route gaining and losing focus.
const focus = vi.hoisted(() => ({
  effect: undefined as (() => (() => void) | undefined) | undefined,
}));

vi.mock('expo', () => ({
  requireOptionalNativeModule: () => (capability.launcherEntryPoint ? launcher : null),
}));

vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => (() => void) | undefined) => {
    focus.effect = effect;
  },
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

/** Simulates the route gaining focus; returns the cleanup that blur runs. */
function focusRoute(): () => void {
  const focusEffect = focus.effect;
  let cleanup: (() => void) | undefined = undefined;
  act(() => {
    cleanup = focusEffect?.();
  });
  return () => {
    cleanup?.();
  };
}

function resetCaptures(): void {
  focus.effect = undefined;
  head.children = undefined;
  head.renders = 0;
  launcher.publishSession.mockClear();
  launcher.clearSession.mockClear();
}

describe('SessionHandoffAdvertiser: Android publishes the launcher entry point', () => {
  beforeEach(() => {
    capability.launcherEntryPoint = true;
    resetCaptures();
  });

  it('publishes nothing while the session is mounted but not the visible one', () => {
    renderAdvertiser();

    expect(launcher.publishSession).not.toHaveBeenCalled();
  });

  it('publishes the session link and its position when the route is focused', () => {
    renderAdvertiser();

    focusRoute();

    expect(launcher.publishSession).toHaveBeenCalledWith(SESSION_URL, SESSION_TITLE, ANCHOR_ID);
  });

  it('clears the entry point when the route loses focus', () => {
    renderAdvertiser();
    const blur = focusRoute();
    launcher.clearSession.mockClear();

    blur();

    expect(launcher.clearSession).toHaveBeenCalledTimes(1);
  });

  it('advertises nothing for a session with no id, focused or not', () => {
    renderAdvertiser({ sessionId: '' });

    expect(launcher.publishSession).not.toHaveBeenCalled();

    focusRoute();

    expect(launcher.publishSession).not.toHaveBeenCalled();
    expect(launcher.clearSession).toHaveBeenCalled();
  });

  it('hands Head the same link, position and handoff opt-in as iOS', () => {
    renderAdvertiser();

    expect(headMeta('og:url')?.props.content).toBe(SESSION_URL);
    expect(headMeta('expo:handoff')?.props.content).toBe('true');
  });
});

describe('SessionHandoffAdvertiser: no launcher entry point module (iOS)', () => {
  beforeEach(() => {
    capability.launcherEntryPoint = false;
    resetCaptures();
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

  it('skips the absent launcher entry point instead of failing', () => {
    renderAdvertiser();

    focusRoute();

    expect(launcher.publishSession).not.toHaveBeenCalled();
    expect(launcher.clearSession).not.toHaveBeenCalled();
  });
});
