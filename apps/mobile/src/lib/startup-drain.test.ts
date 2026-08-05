/* oxlint-disable @typescript-eslint/no-unsafe-call @typescript-eslint/no-unsafe-member-access */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  captureEvent: vi.fn(),
  isPostHogReady: vi.fn().mockReturnValue(false),
  allowsOptional: vi.fn().mockReturnValue(true),
  currentGeneration: vi.fn().mockReturnValue(0),
}));

vi.mock('@/lib/analytics/posthog', () => ({
  APP_STARTUP_EVENT: 'app_startup',
  captureEvent: hoisted.captureEvent,
  isPostHogReady: hoisted.isPostHogReady,
  subscribeToPostHogReady: vi.fn(),
}));

vi.mock('@/lib/telemetry/controller', () => ({
  allowsOptional: hoisted.allowsOptional,
  currentGeneration: hoisted.currentGeneration,
}));

// Reload both modules together so the drain helper shares the same
// startup-timing module instance (not a fresh one with no marks).
async function freshModules() {
  vi.resetModules();
  // Order matters: drain imports timing, so import timing first to ensure
  // the same cached module instance is used by both imports.
  const timing = await import('@/lib/startup-timing');
  const drain = await import('@/lib/startup-drain');
  return { timing, drain };
}

// These tests prove the real shared drain helper `drainStartupTimings`.
// The helper is the production code the layout effect calls — removing any
// guard or the capture call must cause a test failure.
describe('startup drain guard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    hoisted.captureEvent.mockReset();
    hoisted.isPostHogReady.mockReset().mockReturnValue(false);
    hoisted.allowsOptional.mockReset().mockReturnValue(true);
    hoisted.currentGeneration.mockReset().mockReturnValue(0);
  });

  // ── guard proofs ────────────────────────────────────────────────

  it('does not consume timings when optional consent is off', async () => {
    const { timing, drain } = await freshModules();
    timing.markStartup('auth_ready');
    timing.markStartupComplete('app');

    // optionalConsent=false → skip.
    drain.drainStartupTimings({
      hasToken: true,
      consentChecked: true,
      needsConsent: false,
      optionalConsent: false,
      postHogReady: true,
    });

    expect(hoisted.captureEvent).not.toHaveBeenCalled();

    // Timings survive.
    const result = timing.takeStartupTimings();
    expect(result).not.toBeNull();
    expect(result?.outcome).toBe('app');
  });

  it('does not consume timings when PostHog is not ready', async () => {
    const { timing, drain } = await freshModules();
    timing.markStartup('auth_ready');
    timing.markStartupComplete('app');

    drain.drainStartupTimings({
      hasToken: true,
      consentChecked: true,
      needsConsent: false,
      optionalConsent: true,
      postHogReady: false,
    });

    expect(hoisted.captureEvent).not.toHaveBeenCalled();

    const result = timing.takeStartupTimings();
    expect(result).not.toBeNull();
  });

  it('does not consume timings when analytics is not allowed (signed out)', async () => {
    const { timing, drain } = await freshModules();
    timing.markStartup('auth_ready');
    timing.markStartupComplete('app');

    drain.drainStartupTimings({
      hasToken: false,
      consentChecked: false,
      needsConsent: false,
      optionalConsent: true,
      postHogReady: true,
    });

    expect(hoisted.captureEvent).not.toHaveBeenCalled();

    const result = timing.takeStartupTimings();
    expect(result).not.toBeNull();
  });

  it('does not consume timings when consent is unchecked', async () => {
    const { timing, drain } = await freshModules();
    timing.markStartup('auth_ready');
    timing.markStartupComplete('app');

    drain.drainStartupTimings({
      hasToken: true,
      consentChecked: false,
      needsConsent: false,
      optionalConsent: true,
      postHogReady: true,
    });

    expect(hoisted.captureEvent).not.toHaveBeenCalled();

    const result = timing.takeStartupTimings();
    expect(result).not.toBeNull();
  });

  it('does not consume timings when user needs consent', async () => {
    const { timing, drain } = await freshModules();
    timing.markStartup('auth_ready');
    timing.markStartupComplete('app');

    drain.drainStartupTimings({
      hasToken: true,
      consentChecked: true,
      needsConsent: true,
      optionalConsent: true,
      postHogReady: true,
    });

    expect(hoisted.captureEvent).not.toHaveBeenCalled();

    const result = timing.takeStartupTimings();
    expect(result).not.toBeNull();
  });

  // ── capture proofs ────────────────────────────────────────────────

  it('captures exactly once when every guard passes', async () => {
    const { timing, drain } = await freshModules();
    timing.markStartup('auth_ready');
    timing.markStartupComplete('app');

    hoisted.isPostHogReady.mockReturnValue(true);

    drain.drainStartupTimings({
      hasToken: true,
      consentChecked: true,
      needsConsent: false,
      optionalConsent: true,
      postHogReady: true,
    });

    expect(hoisted.captureEvent).toHaveBeenCalledTimes(1);
    expect(hoisted.captureEvent).toHaveBeenCalledWith(
      'app_startup',
      expect.objectContaining({ outcome: 'app' })
    );

    // Second call: already taken.
    drain.drainStartupTimings({
      hasToken: true,
      consentChecked: true,
      needsConsent: false,
      optionalConsent: true,
      postHogReady: true,
    });
    expect(hoisted.captureEvent).toHaveBeenCalledTimes(1);
  });

  it('retains timings while optional consent is off, then captures once on consent', async () => {
    const { timing, drain } = await freshModules();
    timing.markStartup('auth_ready');
    timing.markStartup('consent_ready');
    timing.markStartupComplete('app');

    // Phase 1: optionalConsent=false → drain skips.
    drain.drainStartupTimings({
      hasToken: true,
      consentChecked: true,
      needsConsent: false,
      optionalConsent: false,
      postHogReady: true,
    });
    expect(hoisted.captureEvent).not.toHaveBeenCalled();

    // Phase 2: optionalConsent=true → drain fires.
    drain.drainStartupTimings({
      hasToken: true,
      consentChecked: true,
      needsConsent: false,
      optionalConsent: true,
      postHogReady: true,
    });
    expect(hoisted.captureEvent).toHaveBeenCalledTimes(1);
    expect(hoisted.captureEvent).toHaveBeenCalledWith(
      'app_startup',
      expect.objectContaining({ outcome: 'app' })
    );
  });

  it('retains timings while PostHog is not ready, then captures once when ready', async () => {
    const { timing, drain } = await freshModules();
    timing.markStartup('auth_ready');
    timing.markStartupComplete('app');

    // Phase 1: PostHog not ready.
    drain.drainStartupTimings({
      hasToken: true,
      consentChecked: true,
      needsConsent: false,
      optionalConsent: true,
      postHogReady: false,
    });
    expect(hoisted.captureEvent).not.toHaveBeenCalled();

    // Phase 2: PostHog ready.
    hoisted.isPostHogReady.mockReturnValue(true);
    drain.drainStartupTimings({
      hasToken: true,
      consentChecked: true,
      needsConsent: false,
      optionalConsent: true,
      postHogReady: true,
    });
    expect(hoisted.captureEvent).toHaveBeenCalledTimes(1);
    expect(hoisted.captureEvent).toHaveBeenCalledWith(
      'app_startup',
      expect.objectContaining({ outcome: 'app' })
    );
  });
});
