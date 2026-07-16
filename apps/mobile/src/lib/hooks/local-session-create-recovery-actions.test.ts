import { describe, expect, it, vi } from 'vitest';

import { type LocalSessionCreateRecovery } from './local-session-create-errors';
import {
  resolveRecoveryCtaAction,
  type ResolveRecoveryCtaActionInput,
} from './local-session-create-recovery-actions';

function makeHandlers() {
  return {
    onRetry: vi.fn(),
    onCheckAgain: vi.fn(),
    onSelectRuntime: vi.fn(),
    onRefreshCatalog: vi.fn(),
  };
}

function makeRecovery(partial: Partial<LocalSessionCreateRecovery>): LocalSessionCreateRecovery {
  return partial as LocalSessionCreateRecovery;
}

const baseInput: Omit<ResolveRecoveryCtaActionInput, 'recovery'> = {
  ...makeHandlers(),
  isSubmitting: false,
};

describe('resolveRecoveryCtaAction', () => {
  it('returns none when recovery is null', () => {
    const result = resolveRecoveryCtaAction({ ...baseInput, recovery: null });
    expect(result.kind).toBe('none');
  });

  it('returns none for the non-retryable CLI upgrade branch (ctaLabel null)', () => {
    const recovery = makeRecovery({
      kind: 'non-retryable-cli-upgrade',
      message: 'Update Kilo CLI and reconnect.',
      ctaLabel: null,
    });
    const result = resolveRecoveryCtaAction({ ...baseInput, recovery });
    expect(result.kind).toBe('none');
  });

  it('returns none for the non-retryable malformed branch (ctaLabel null)', () => {
    const recovery = makeRecovery({
      kind: 'non-retryable-malformed',
      message: 'Unsupported response.',
      ctaLabel: null,
    });
    const result = resolveRecoveryCtaAction({ ...baseInput, recovery });
    expect(result.kind).toBe('none');
  });

  it('returns none for the non-retryable access-lost branch (ctaLabel null)', () => {
    const recovery = makeRecovery({
      kind: 'non-retryable-access-lost',
      message: 'You no longer have access to this session.',
      ctaLabel: null,
    });
    const result = resolveRecoveryCtaAction({ ...baseInput, recovery });
    expect(result.kind).toBe('none');
  });

  it('maps a Retry CTA exactly to the retry handler with the verbatim label', () => {
    const handlers = makeHandlers();
    const recovery = makeRecovery({
      kind: 'transient',
      message: 'transient',
      ctaLabel: 'Retry',
    });
    const result = resolveRecoveryCtaAction({ ...handlers, isSubmitting: false, recovery });
    if (result.kind !== 'retry') {
      throw new Error('expected retry action');
    }
    expect(result.label).toBe('Retry');
    result.onPress();
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
    expect(handlers.onCheckAgain).not.toHaveBeenCalled();
    expect(handlers.onSelectRuntime).not.toHaveBeenCalled();
    expect(handlers.onRefreshCatalog).not.toHaveBeenCalled();
  });

  it('maps the limit branch CTA Retry to the retry handler', () => {
    const handlers = makeHandlers();
    const recovery = makeRecovery({
      kind: 'limit',
      message: 'limit',
      ctaLabel: 'Retry',
    });
    const result = resolveRecoveryCtaAction({ ...handlers, isSubmitting: false, recovery });
    expect(result.kind).toBe('retry');
    if (result.kind !== 'retry') {
      throw new Error('expected retry action');
    }
    result.onPress();
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
  });

  it('maps a Check again CTA exactly to the check-again handler', () => {
    const handlers = makeHandlers();
    const recovery = makeRecovery({
      kind: 'readiness-timeout',
      message: 'not ready',
      ctaLabel: 'Check again',
    });
    const result = resolveRecoveryCtaAction({ ...handlers, isSubmitting: false, recovery });
    if (result.kind !== 'check-again') {
      throw new Error('expected check-again action');
    }
    expect(result.label).toBe('Check again');
    result.onPress();
    expect(handlers.onCheckAgain).toHaveBeenCalledTimes(1);
    expect(handlers.onRetry).not.toHaveBeenCalled();
  });

  it('maps a Select runtime CTA exactly to the select-runtime handler', () => {
    const handlers = makeHandlers();
    const recovery = makeRecovery({
      kind: 'fence-changed',
      message: 'fence changed',
      ctaLabel: 'Select runtime',
    });
    const result = resolveRecoveryCtaAction({ ...handlers, isSubmitting: false, recovery });
    if (result.kind !== 'select-runtime') {
      throw new Error('expected select-runtime action');
    }
    expect(result.label).toBe('Select runtime');
    result.onPress();
    expect(handlers.onSelectRuntime).toHaveBeenCalledTimes(1);
    expect(handlers.onRefreshCatalog).not.toHaveBeenCalled();
  });

  it('maps a Refresh catalog CTA exactly to the refresh-catalog handler', () => {
    const handlers = makeHandlers();
    const recovery = makeRecovery({
      kind: 'catalog-changed',
      message: 'catalog changed',
      ctaLabel: 'Refresh catalog',
    });
    const result = resolveRecoveryCtaAction({ ...handlers, isSubmitting: false, recovery });
    if (result.kind !== 'refresh-catalog') {
      throw new Error('expected refresh-catalog action');
    }
    expect(result.label).toBe('Refresh catalog');
    result.onPress();
    expect(handlers.onRefreshCatalog).toHaveBeenCalledTimes(1);
    expect(handlers.onSelectRuntime).not.toHaveBeenCalled();
  });

  it('still resolves the action while submitting (rendering layer owns the disabled flag)', () => {
    const handlers = makeHandlers();
    const recovery = makeRecovery({
      kind: 'transient',
      message: 'transient',
      ctaLabel: 'Retry',
    });
    const result = resolveRecoveryCtaAction({ ...handlers, isSubmitting: true, recovery });
    if (result.kind !== 'retry') {
      throw new Error('expected retry action');
    }
    expect(result.label).toBe('Retry');
  });
});
