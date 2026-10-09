/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- the press handler loads native modules, so its target literal is read from disk */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildGlanceableSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { describe, expect, it, vi } from 'vitest';

import { type LiveActivityEnvironment } from 'expo-widgets';

import { activeAgentsLiveActivityLayout } from './active-agents-live-activity';
import { buildGlanceableLiveActivityContentState } from './view-props';

function mockComponent(kind: string) {
  return Object.assign((props: Record<string, unknown>) => ({ kind, props }), { kind });
}

function mockModifier(name: string) {
  return (args?: unknown) => ({ $type: name, args });
}

vi.mock('expo-widgets', () => ({ createLiveActivity: () => ({}) }));
vi.mock('@expo/ui/swift-ui', () => ({
  Button: mockComponent('Button'),
  Circle: mockComponent('Circle'),
  HStack: mockComponent('HStack'),
  RoundedRectangle: mockComponent('RoundedRectangle'),
  Spacer: mockComponent('Spacer'),
  Text: mockComponent('Text'),
  VStack: mockComponent('VStack'),
}));
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityElement: mockModifier('accessibilityElement'),
  accessibilityLabel: mockModifier('accessibilityLabel'),
  activityBackgroundTint: mockModifier('activityBackgroundTint'),
  background: (style: unknown) => ({ $type: 'background', args: style }),
  buttonStyle: mockModifier('buttonStyle'),
  environment: mockModifier('environment'),
  fixedSize: mockModifier('fixedSize'),
  font: mockModifier('font'),
  foregroundStyle: mockModifier('foregroundStyle'),
  frame: mockModifier('frame'),
  lineLimit: mockModifier('lineLimit'),
  monospacedDigit: mockModifier('monospacedDigit'),
  padding: mockModifier('padding'),
  shapes: { capsule: () => ({}), roundedRectangle: () => ({}) },
}));
vi.mock('@/i18n', () => ({ i18n: { on: vi.fn(), t: (key: string) => key } }));

type Rendered = { kind: string; props: Record<string, unknown> };
type State = Parameters<typeof activeAgentsLiveActivityLayout>[0];

function element(node: unknown): Rendered | null {
  // eslint-disable-next-line anti-slop/no-runtime-typeof -- walks the untyped JSX element tree
  if (node === null || typeof node !== 'object' || !('type' in node) || !('props' in node)) {
    return null;
  }
  const { type, props } = node;
  // eslint-disable-next-line anti-slop/no-runtime-typeof -- walks the untyped JSX element tree
  if (typeof type !== 'function' || !('kind' in type) || typeof type.kind !== 'string') {
    return null;
  }
  // A JSX element's props object; every reader below narrows the field it uses.
  const record = props as Record<string, unknown>;
  return { kind: type.kind, props: record };
}

function collect(node: unknown): Rendered[] {
  const root = element(node);
  if (root === null) {
    return Array.isArray(node) ? node.flatMap(item => collect(item)) : [];
  }
  const raw = root.props.children;
  const kids = Array.isArray(raw) ? raw.flat(Infinity) : [raw];
  return [root, ...kids.flatMap(child => collect(child))];
}

const texts = (node: unknown) =>
  collect(node)
    .filter(item => item.kind === 'Text' && typeof item.props.children === 'string')
    .map(item => item.props.children as string);
const buttons = (node: unknown) => collect(node).filter(item => item.kind === 'Button');

const UPDATED_AT = new Date().toISOString();
const ENVIRONMENT: LiveActivityEnvironment = { colorScheme: 'light' };

function render(state: State, environment: LiveActivityEnvironment = ENVIRONMENT) {
  return activeAgentsLiveActivityLayout(state, environment);
}

const PERMISSION: State = {
  status: 'happy',
  needsInput: 2,
  needsApproval: 1,
  running: 3,
  scheduled: 1,
  idle: 0,
  updatedAt: UPDATED_AT,
  canApprove: true,
};

describe('Live Activity Lock Screen card (round 7)', () => {
  it('draws the header, the status row, Approve, and the other counts', () => {
    const { banner } = render(PERMISSION);
    expect(texts(banner)).toEqual([
      'Kilo',
      'Checked',
      '2',
      'Needs input',
      'Approve',
      '3 Working · 1 Scheduled',
    ]);
    expect(buttons(banner).map(button => button.props.target)).toEqual(['approve']);
    expect(collect(banner).some(item => item.props.dateStyle === 'time')).toBe(true);
  });

  it('swaps Approve for Approving… while the press is in flight', () => {
    const { banner, expandedBottom } = render({ ...PERMISSION, approving: true });
    for (const surface of [banner, expandedBottom]) {
      expect(buttons(surface)).toEqual([]);
      expect(texts(surface)).toContain('Approving…');
    }
  });

  it('keeps Approve and prints the failure line instead of the other counts', () => {
    const notice = "Couldn't approve. Tap Approve to try again.";
    const { banner } = render({ ...PERMISSION, notice });
    expect(texts(banner)).toContain(notice);
    expect(texts(banner)).not.toContain('3 Working · 1 Scheduled');
    expect(buttons(banner)).toHaveLength(1);
  });

  it('offers Approve only while an approvable ask waits', () => {
    const offered = (state: State) => buttons(render(state).banner).length > 0;
    expect(offered(PERMISSION)).toBe(true);
    expect(offered({ ...PERMISSION, canApprove: false })).toBe(false);
    // A server-written question-only state carries no flag and no approvable count.
    expect(offered({ ...PERMISSION, needsApproval: 0, canApprove: undefined })).toBe(false);
    expect(offered({ ...PERMISSION, needsApproval: 1, canApprove: undefined })).toBe(true);
    // The expired frame zeroes the wait but leaves the approvable count.
    expect(offered({ ...PERMISSION, needsInput: 0 })).toBe(false);
  });

  it('drops the bottom line for a lone question and prints Next run for scheduled only', () => {
    const question = render({ status: 'happy', needsInput: 1, updatedAt: UPDATED_AT }).banner;
    expect(texts(question)).toEqual(['Kilo', 'Checked', '1', 'Needs input']);
    const scheduled = render({
      status: 'happy',
      scheduled: 2,
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      updatedAt: UPDATED_AT,
    }).banner;
    expect(texts(scheduled)).toContain('Next run');
  });

  it('says Last known on a stale card and prints no time without updatedAt', () => {
    expect(texts(render({ ...PERMISSION, status: 'stale' }).banner)).toContain('Last known ·');
    expect(texts(render(PERMISSION, { colorScheme: 'dark', isStale: true }).banner)).toContain(
      'Last known ·'
    );
    const legacy = render({ ...PERMISSION, updatedAt: undefined }).banner;
    expect(texts(legacy)).not.toContain('Checked');
  });

  it('keeps the spoken count block apart from the Approve control', () => {
    const combined = collect(render(PERMISSION).banner).filter(item =>
      (Array.isArray(item.props.modifiers) ? item.props.modifiers : []).some(
        (modifier: { $type?: string; args?: unknown }) =>
          modifier.$type === 'accessibilityElement' && modifier.args === 'combine'
      )
    );
    expect(combined).toHaveLength(1);
    expect(buttons(combined[0])).toEqual([]);
  });

  it('paints the card background from the colour scheme', () => {
    const tint = (scheme: 'light' | 'dark') =>
      collect(render(PERMISSION, { colorScheme: scheme }).banner)
        .flatMap(item => (Array.isArray(item.props.modifiers) ? item.props.modifiers : []))
        .find((modifier: { $type?: string }) => modifier.$type === 'activityBackgroundTint');
    expect(tint('light')).toEqual({ $type: 'activityBackgroundTint', args: '#FBFAF5' });
    expect(tint('dark')).toEqual({ $type: 'activityBackgroundTint', args: '#17171A' });
  });
});

describe('Live Activity Dynamic Island (round 7)', () => {
  it('draws the dot and count in compact and minimal, capping minimal at 99+', () => {
    const layout = render({ ...PERMISSION, needsInput: 120 });
    expect(texts(layout.compactTrailing)).toEqual(['120']);
    expect(texts(layout.minimal)).toEqual(['99+']);
    for (const surface of [layout.compactLeading, layout.compactTrailing, layout.minimal]) {
      expect(buttons(surface)).toEqual([]);
    }
  });

  it('repeats the card with Approve in the expanded island', () => {
    const { expandedBottom } = render(PERMISSION);
    expect(texts(expandedBottom)).toContain('3 Working · 1 Scheduled');
    expect(buttons(expandedBottom).map(button => button.props.target)).toEqual(['approve']);
  });
});

describe('Live Activity press target', () => {
  it('declares only the target interaction.ts routes', () => {
    const declared = /export const GLANCEABLE_APPROVE_TARGET = '([^']+)'/.exec(
      readFileSync(join(__dirname, 'interaction.ts'), 'utf8')
    )?.[1];
    const layout = render(PERMISSION);
    const targets = Object.values(layout).flatMap(surface =>
      buttons(surface).map(button => button.props.target)
    );
    expect(new Set(targets)).toEqual(new Set([declared]));
  });
});

describe('Live Activity content state', () => {
  it('carries the counts, the checked time, and the ISO wake', () => {
    const snapshot = buildGlanceableSnapshot({
      sessions: [{ status: 'scheduled', scheduledAt: '2026-09-24T09:00:00.000Z' }],
      userId: 'u1',
      organizationId: null,
      now: Date.parse('2026-01-02T00:00:00.000Z'),
    });
    const contentState = buildGlanceableLiveActivityContentState(snapshot);
    expect(contentState.scheduled).toBe(1);
    expect(contentState.scheduledAt).toBe('2026-09-24T09:00:00.000Z');
    expect(contentState.updatedAt).toBe('2026-01-02T00:00:00.000Z');
  });
});
