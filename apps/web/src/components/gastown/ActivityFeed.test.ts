import { describe, it, expect } from '@jest/globals';
import { eventDescription } from './ActivityFeed';

describe('eventDescription', () => {
  const baseEvent = {
    old_value: null as string | null,
    new_value: null as string | null,
    metadata: {} as Record<string, unknown>,
    rig_name: undefined as string | undefined,
  };

  it('formats babysit_started event', () => {
    expect(eventDescription({ ...baseEvent, event_type: 'babysit_started' })).toBe(
      'Babysit started for external PR'
    );
  });

  it('formats pr_feedback_detected event', () => {
    expect(eventDescription({ ...baseEvent, event_type: 'pr_feedback_detected' })).toBe(
      'PR feedback detected'
    );
  });

  it('formats pr_feedback_detected event with kind metadata', () => {
    expect(
      eventDescription({
        ...baseEvent,
        event_type: 'pr_feedback_detected',
        metadata: { kind: 'ci_failure' },
      })
    ).toBe('PR feedback detected: ci_failure');
  });

  it('formats pr_conflict_detected event', () => {
    expect(eventDescription({ ...baseEvent, event_type: 'pr_conflict_detected' })).toBe(
      'PR merge conflict detected'
    );
  });

  it('formats pr_auto_merge event', () => {
    expect(eventDescription({ ...baseEvent, event_type: 'pr_auto_merge' })).toBe(
      'PR auto-merge initiated'
    );
  });

  it('formats pr_status_changed event with old/new values', () => {
    expect(
      eventDescription({
        ...baseEvent,
        event_type: 'pr_status_changed',
        old_value: 'open',
        new_value: 'merged',
      })
    ).toBe('PR state: open → merged');
  });

  it('formats pr_status_changed event with missing values', () => {
    expect(eventDescription({ ...baseEvent, event_type: 'pr_status_changed' })).toBe(
      'PR state: ? → ?'
    );
  });

  it('formats babysit_started with rig prefix', () => {
    expect(
      eventDescription({
        ...baseEvent,
        event_type: 'babysit_started',
        rig_name: 'my-rig',
      })
    ).toBe('[my-rig] Babysit started for external PR');
  });

  it('falls back to raw event_type for unknown events', () => {
    expect(eventDescription({ ...baseEvent, event_type: 'unknown_event' })).toBe('unknown_event');
  });
});
