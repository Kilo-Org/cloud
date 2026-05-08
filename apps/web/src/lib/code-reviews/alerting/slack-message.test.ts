import { buildCodeReviewAlertMessage } from './slack-message';

type TestAlertDetails = Parameters<typeof buildCodeReviewAlertMessage>[0];

describe('buildCodeReviewAlertMessage', () => {
  const appUrl = 'https://app.kilo.ai';

  it.each([
    [
      'failure rate',
      {
        kind: 'failure_rate',
        rate: 0.342,
        total: 32,
        failures: 11,
        topReason: 'timeout',
        topReasonCount: 7,
      } satisfies TestAlertDetails,
    ],
    [
      'stuck reviews',
      { kind: 'stuck_reviews', queuedCount: 8, runningCount: 3 } satisfies TestAlertDetails,
    ],
    ['no completions', { kind: 'no_completions', createdCount: 12 } satisfies TestAlertDetails],
    [
      'error spike',
      {
        kind: 'error_spike',
        reason: 'upstream_error',
        count: 10,
        total: 14,
        share: 10 / 14,
      } satisfies TestAlertDetails,
    ],
  ])('builds a stable Slack payload for %s', (name, details) => {
    const message = buildCodeReviewAlertMessage(details, appUrl);

    expect(message.blocks[0]).toEqual({
      type: 'header',
      text: {
        type: 'plain_text',
        text: ':ticket: TICKET — Code Review Pipeline Health',
        emoji: true,
      },
    });
    expect(message.blocks[2]).toEqual(
      expect.objectContaining({
        type: 'section',
        text: expect.objectContaining({
          text: expect.stringContaining(
            '<https://app.kilo.ai/admin/code-reviews|View admin dashboard>'
          ),
        }),
      })
    );
    const expectedMessage = expectedMessages[name];
    if (!expectedMessage) throw new Error(`Missing expected message for ${name}`);
    expect(message).toEqual(expectedMessage);
  });
});

const expectedMessages: Record<string, ReturnType<typeof buildCodeReviewAlertMessage>> = {
  'failure rate': {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: ':ticket: TICKET — Code Review Pipeline Health',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: '*Type:*\nHigh Failure Rate' },
          { type: 'mrkdwn', text: '*Window:*\n30 min' },
          { type: 'mrkdwn', text: '*Failure rate:*\n34.2% (11/32)' },
          { type: 'mrkdwn', text: '*Threshold:*\n> 25.0%' },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*High Failure Rate*\nSystem failures exceeded the pipeline threshold.\nTop reason: timeout (7)\n<https://app.kilo.ai/admin/code-reviews|View admin dashboard>',
        },
      },
    ],
  },
  'stuck reviews': {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: ':ticket: TICKET — Code Review Pipeline Health',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: '*Type:*\nStuck Reviews' },
          { type: 'mrkdwn', text: '*Queued > 15m:*\n8' },
          { type: 'mrkdwn', text: '*Running > 2h:*\n3' },
          { type: 'mrkdwn', text: '*Threshold:*\n>= 5 of either' },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Stuck Reviews*\n8 queued and 3 running reviews are beyond recovery thresholds.\n<https://app.kilo.ai/admin/code-reviews|View admin dashboard>',
        },
      },
    ],
  },
  'no completions': {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: ':ticket: TICKET — Code Review Pipeline Health',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: '*Type:*\nNo Completions' },
          { type: 'mrkdwn', text: '*Window:*\n30 min' },
          { type: 'mrkdwn', text: '*Created:*\n12' },
          { type: 'mrkdwn', text: '*Completed:*\n0' },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*No Completions*\n12 reviews were created with zero completions in the current window.\n<https://app.kilo.ai/admin/code-reviews|View admin dashboard>',
        },
      },
    ],
  },
  'error spike': {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: ':ticket: TICKET — Code Review Pipeline Health',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: '*Type:*\nError Category Spike' },
          { type: 'mrkdwn', text: '*Window:*\n30 min' },
          { type: 'mrkdwn', text: '*Top reason:*\nupstream error' },
          { type: 'mrkdwn', text: '*Share:*\n71.4% (10/14)' },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Error Category Spike*\nOne terminal reason is >= 50.0% of failures with at least 6 failures.\n<https://app.kilo.ai/admin/code-reviews|View admin dashboard>',
        },
      },
    ],
  },
};
