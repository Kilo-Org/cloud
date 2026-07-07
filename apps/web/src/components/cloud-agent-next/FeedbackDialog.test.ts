import { describe, expect, it } from '@jest/globals';
import { feedbackModelForSession } from './FeedbackDialog';

describe('feedbackModelForSession', () => {
  it('retains the Gateway model only for Cloud Agent feedback', () => {
    expect(feedbackModelForSession('cloud-agent', 'anthropic/claude-sonnet-4')).toBe(
      'anthropic/claude-sonnet-4'
    );
    expect(feedbackModelForSession('remote', 'private-provider/private-model')).toBeUndefined();
    expect(feedbackModelForSession('read-only', 'private-provider/private-model')).toBeUndefined();
    expect(feedbackModelForSession(null, 'private-provider/private-model')).toBeUndefined();
  });
});
