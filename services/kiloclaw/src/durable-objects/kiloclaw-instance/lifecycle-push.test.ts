import { describe, expect, it } from 'vitest';

import { formatStartFailureReason } from './lifecycle-push';

describe('formatStartFailureReason', () => {
  it('returns a specific sentence for every known label', () => {
    expect(formatStartFailureReason('starting_timeout')).toContain('Setup is taking longer');
    expect(formatStartFailureReason('starting_timeout_with_machine')).toContain(
      "didn't finish booting"
    );
    expect(formatStartFailureReason('starting_machine_gone')).toContain('went missing');
    expect(formatStartFailureReason('starting_timeout_transient_error')).toContain('temporary');
    expect(formatStartFailureReason('fly_failed_state')).toContain('failed state');
  });

  it('falls back to a generic sentence for unknown labels', () => {
    expect(formatStartFailureReason('some_new_label')).toBe('Start failed.');
  });
});
