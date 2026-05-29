import { describe, it, expect } from '@jest/globals';
import { eventDescription } from './eventDescription';

describe('eventDescription: babysit event types', () => {
  const base = {
    old_value: null,
    new_value: null,
    metadata: {},
    rig_name: undefined,
  };

  it('renders babysit_started with default description', () => {
    expect(eventDescription({ ...base, event_type: 'babysit_started' })).toBe(
      'Babysit started — town is now monitoring this PR'
    );
  });

  it('renders babysit_started with rig prefix', () => {
    expect(eventDescription({ ...base, event_type: 'babysit_started', rig_name: 'my-rig' })).toBe(
      '[my-rig] Babysit started — town is now monitoring this PR'
    );
  });

  it('renders pr_feedback_detected without source', () => {
    expect(eventDescription({ ...base, event_type: 'pr_feedback_detected' })).toBe(
      'PR feedback detected'
    );
  });

  it('renders pr_feedback_detected with source from metadata', () => {
    expect(
      eventDescription({
        ...base,
        event_type: 'pr_feedback_detected',
        metadata: { source: 'ci-failure' },
      })
    ).toBe('PR feedback detected (ci-failure)');
  });

  it('renders pr_conflict_detected', () => {
    expect(eventDescription({ ...base, event_type: 'pr_conflict_detected' })).toBe(
      'PR merge conflict detected'
    );
  });

  it('renders pr_auto_merge', () => {
    expect(eventDescription({ ...base, event_type: 'pr_auto_merge' })).toBe(
      'PR auto-merge triggered'
    );
  });

  it('renders pr_status_changed with new_value', () => {
    expect(
      eventDescription({ ...base, event_type: 'pr_status_changed', new_value: 'merged' })
    ).toBe('PR status changed: merged');
  });

  it('renders pr_status_changed without new_value', () => {
    expect(eventDescription({ ...base, event_type: 'pr_status_changed' })).toBe(
      'PR status changed: unknown'
    );
  });
});

describe('eventDescription: existing event types still work', () => {
  const base = {
    old_value: null,
    new_value: null,
    metadata: {},
    rig_name: undefined,
  };

  it('renders created event', () => {
    expect(
      eventDescription({ ...base, event_type: 'created', metadata: { title: 'My Bead' } })
    ).toBe('Bead created: My Bead');
  });

  it('renders status_changed event', () => {
    expect(
      eventDescription({
        ...base,
        event_type: 'status_changed',
        old_value: 'open',
        new_value: 'in_progress',
      })
    ).toBe('Status: open → in_progress');
  });

  it('falls through to raw event_type for unknown events', () => {
    expect(eventDescription({ ...base, event_type: 'some_future_event' })).toBe(
      'some_future_event'
    );
  });
});
