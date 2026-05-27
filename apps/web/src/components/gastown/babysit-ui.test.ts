import { describe, it, expect } from '@jest/globals';
import { eventDescription } from '@/components/gastown/event-description';

describe('eventDescription — babysit event types', () => {
  it('formats babysit_started with branch and pr_url', () => {
    const desc = eventDescription({
      event_type: 'babysit_started',
      old_value: null,
      new_value: 'https://github.com/Org/repo/pull/42',
      metadata: {
        branch: 'feature/x',
        pr_url: 'https://github.com/Org/repo/pull/42',
      },
    });
    expect(desc).toContain('Babysit started');
    expect(desc).toContain('feature/x');
    expect(desc).toContain('https://github.com/Org/repo/pull/42');
  });

  it('formats babysit_started without branch or pr_url', () => {
    const desc = eventDescription({
      event_type: 'babysit_started',
      old_value: null,
      new_value: null,
      metadata: {},
    });
    expect(desc).toContain('Babysit started');
  });

  it('formats pr_feedback_detected', () => {
    const desc = eventDescription({
      event_type: 'pr_feedback_detected',
      old_value: null,
      new_value: 'CI failure',
      metadata: {},
    });
    expect(desc).toContain('PR feedback detected');
    expect(desc).toContain('CI failure');
  });

  it('formats pr_conflict_detected', () => {
    const desc = eventDescription({
      event_type: 'pr_conflict_detected',
      old_value: null,
      new_value: null,
      metadata: {},
    });
    expect(desc).toContain('PR merge conflict detected');
  });

  it('formats pr_auto_merge', () => {
    const desc = eventDescription({
      event_type: 'pr_auto_merge',
      old_value: null,
      new_value: null,
      metadata: {},
    });
    expect(desc).toContain('PR auto-merge triggered');
  });

  it('formats pr_status_changed with state from metadata', () => {
    const desc = eventDescription({
      event_type: 'pr_status_changed',
      old_value: null,
      new_value: null,
      metadata: { state: 'merged' },
    });
    expect(desc).toContain('PR status changed');
    expect(desc).toContain('merged');
  });

  it('formats pr_status_changed falling back to new_value', () => {
    const desc = eventDescription({
      event_type: 'pr_status_changed',
      old_value: null,
      new_value: 'closed',
      metadata: {},
    });
    expect(desc).toContain('PR status changed');
    expect(desc).toContain('closed');
  });

  it('includes rig prefix when rig_name is present', () => {
    const desc = eventDescription({
      event_type: 'babysit_started',
      old_value: null,
      new_value: null,
      metadata: {},
      rig_name: 'my-rig',
    });
    expect(desc).toContain('[my-rig]');
    expect(desc).toContain('Babysit started');
  });
});
