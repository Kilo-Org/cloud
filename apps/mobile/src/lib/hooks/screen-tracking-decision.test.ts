import { describe, expect, it } from 'vitest';

import { decideScreenTracking, type ScreenTrackingDecision } from './screen-tracking-decision';

function decision(
  overrides: Partial<Parameters<typeof decideScreenTracking>[0]> = {}
): ScreenTrackingDecision {
  return decideScreenTracking({
    segments: ['(app)', '(tabs)', '(0_home)'],
    settled: true,
    analyticsReady: true,
    captureAccepted: true,
    bootstrapSettled: true,
    accountGeneration: 1,
    lastCaptured: null,
    ...overrides,
  });
}

describe('decideScreenTracking', () => {
  it('captures the settled leaf when all gates pass', () => {
    expect(decision()).toEqual({
      capture: true,
      screenName: '(app)/(tabs)/(0_home)',
      reason: 'captured',
    });
  });

  it('keeps bracket placeholders in the captured screen name', () => {
    const result = decision({
      segments: ['(app)', 'agent-chat', '[session-id]'],
    });
    expect(result).toEqual({
      capture: true,
      screenName: '(app)/agent-chat/[session-id]',
      reason: 'captured',
    });
  });

  it('never captures while the route is not settled', () => {
    expect(decision({ settled: false })).toEqual({
      capture: false,
      screenName: '(app)/(tabs)/(0_home)',
      reason: 'not-settled',
    });
  });

  it('never captures while analytics is not ready', () => {
    expect(decision({ analyticsReady: false })).toEqual({
      capture: false,
      screenName: '(app)/(tabs)/(0_home)',
      reason: 'analytics-not-ready',
    });
  });

  it('never captures when the ready client belongs to an older generation', () => {
    expect(decision({ captureAccepted: false })).toEqual({
      capture: false,
      screenName: '(app)/(tabs)/(0_home)',
      reason: 'analytics-client-stale',
    });
  });

  it('never captures while the consent bootstrap is not settled', () => {
    expect(decision({ bootstrapSettled: false })).toEqual({
      capture: false,
      screenName: '(app)/(tabs)/(0_home)',
      reason: 'bootstrap-not-settled',
    });
  });

  it('never captures when there are no segments', () => {
    expect(decision({ segments: [] })).toEqual({
      capture: false,
      screenName: undefined,
      reason: 'no-screen',
    });
  });

  it('never captures the redirect-only (app)/index route', () => {
    expect(decision({ segments: ['(app)', 'index'] })).toEqual({
      capture: false,
      screenName: '(app)/index',
      reason: 'redirect-only',
    });
  });

  it('never captures the redirect-only (app) production representation', () => {
    // Expo Router strips a trailing `index`, so `(app)/index` appears as
    // `['(app)']` through `useSegments()` in production.
    expect(decision({ segments: ['(app)'] })).toEqual({
      capture: false,
      screenName: '(app)',
      reason: 'redirect-only',
    });
  });

  it('captures real (app) leaves that are not the redirect target', () => {
    expect(decision({ segments: ['(app)', 'onboarding'] })).toEqual({
      capture: true,
      screenName: '(app)/onboarding',
      reason: 'captured',
    });
  });

  it('never captures the KiloClaw tab group', () => {
    expect(decision({ segments: ['(app)', '(tabs)', '(1_kiloclaw)'] })).toEqual({
      capture: false,
      screenName: '(app)/(tabs)/(1_kiloclaw)',
      reason: 'kiloclaw-excluded',
    });
  });

  it('never captures kiloclaw settings routes', () => {
    const result = decision({ segments: ['(app)', 'kiloclaw', '[instance-id]', 'settings'] });
    expect(result).toEqual({
      capture: false,
      screenName: '(app)/kiloclaw/[instance-id]/settings',
      reason: 'kiloclaw-excluded',
    });
  });

  it('drops a duplicate capture of the same screen in the same generation', () => {
    expect(
      decision({
        lastCaptured: { generation: 1, screenName: '(app)/(tabs)/(0_home)' },
      })
    ).toEqual({
      capture: false,
      screenName: '(app)/(tabs)/(0_home)',
      reason: 'duplicate',
    });
  });

  it('captures a different screen in the same generation', () => {
    expect(
      decision({
        segments: ['(app)', '(tabs)', '(3_profile)'],
        lastCaptured: { generation: 1, screenName: '(app)/(tabs)/(0_home)' },
      })
    ).toEqual({
      capture: true,
      screenName: '(app)/(tabs)/(3_profile)',
      reason: 'captured',
    });
  });

  it('re-allows the same screen after an account generation change', () => {
    expect(
      decision({
        accountGeneration: 2,
        lastCaptured: { generation: 1, screenName: '(app)/(tabs)/(0_home)' },
      })
    ).toEqual({
      capture: true,
      screenName: '(app)/(tabs)/(0_home)',
      reason: 'captured',
    });
  });

  it('captures when nothing was captured yet even with a late generation', () => {
    expect(decision({ accountGeneration: 5, lastCaptured: null })).toMatchObject({
      capture: true,
    });
  });
});
