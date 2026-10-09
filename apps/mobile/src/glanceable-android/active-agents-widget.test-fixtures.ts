import {
  type buildHomeWidgetData,
  type HomeWidgetSessionRow,
} from '@kilocode/app-shared/home-widget';
import { expect } from 'vitest';

import { type GlanceableActionFeedback, setSurfaceExtras } from '@/lib/glanceable/surface-extras';

import {
  type Element,
  NOW,
  placed,
  propsFor,
  type Rect,
  translate,
  WAKE,
} from './active-agents-widget.test-helpers';

/** Home widget states every renderer test walks. */

const KEY = 'a'.repeat(64);
export const LONG = 'Untangle the payment reconciliation job that keeps timing out every night';
export const PERMISSION: HomeWidgetSessionRow[] = [
  { status: 'permission', title: 'Review the release', approvalKey: KEY },
  { status: 'question', title: 'Pick a color for the badge' },
  { status: 'question', title: 'Choose the migration strategy' },
  { status: 'busy', title: 'Build the app' },
  { status: 'scheduled', title: 'Morning checks', scheduledAt: WAKE },
  { status: 'idle', title: 'Connected agent' },
];
const MIXED: HomeWidgetSessionRow[] = [
  { status: 'busy', title: 'Build the app' },
  { status: 'scheduled', title: 'Morning checks', scheduledAt: WAKE },
  { status: 'idle', title: 'Connected agent' },
];
export type State = {
  sessions: HomeWidgetSessionRow[];
  status?: Parameters<typeof buildHomeWidgetData>[0]['status'];
  feedback?: GlanceableActionFeedback;
};
export const STATES = {
  'needs input with Approve': { sessions: PERMISSION },
  'needs input without Approve': {
    sessions: [
      { status: 'question', title: 'Pick a color for the badge' },
      { status: 'retry', title: 'Recover the interrupted build' },
    ],
  },
  approving: { sessions: PERMISSION, feedback: 'approving' },
  'could not approve': { sessions: PERMISSION, feedback: 'couldNotApprove' },
  working: { sessions: [{ status: 'busy', title: 'Fix the flaky login test' }] },
  idle: { sessions: [{ status: 'idle', title: 'Review the onboarding copy' }] },
  mixed: { sessions: MIXED },
  'scheduled today': {
    sessions: [
      { status: 'scheduled', title: 'Usage report', scheduledAt: WAKE },
      {
        status: 'scheduled',
        title: 'Dependency audit',
        scheduledAt: new Date(NOW + 9e6).toISOString(),
      },
    ],
  },
  'scheduled overdue': {
    sessions: [
      {
        status: 'scheduled',
        title: 'Dependency audit',
        scheduledAt: new Date(NOW - 60_000).toISOString(),
      },
    ],
  },
  'scheduled unknown time': { sessions: [{ status: 'scheduled', title: 'Dependency audit' }] },
  empty: { sessions: [], status: 'empty' },
  updating: { sessions: [], status: 'waiting' },
  privacy: { sessions: PERMISSION, status: 'privacy' },
  'signed out': { sessions: PERMISSION, status: 'signed_out' },
  stress: {
    sessions: [
      { status: 'permission', title: LONG, approvalKey: KEY },
      { status: 'question' },
      ...Array.from({ length: 9997 }, () => ({ status: 'question' as const })),
    ],
  },
} satisfies Record<string, State>;
export function stateProps(state: State, copy = translate) {
  setSurfaceExtras({ newestSessionTitle: null, actionFeedback: state.feedback ?? null });
  return propsFor(state.sessions, state.status, copy);
}

export function close(actual: number, expected: number) {
  expect(actual).toBeCloseTo(expected, 0);
}
/** A placed rect read back in LTR design coordinates. */
export function ltr(rect: Rect, frame: { width: number; rtl: boolean }): Rect {
  return frame.rtl ? { ...rect, x: frame.width - rect.x - rect.width } : rect;
}
export function targets(root: Element) {
  return placed(root).filter(node => node.key === 'create-target' || node.key === 'approve-target');
}
