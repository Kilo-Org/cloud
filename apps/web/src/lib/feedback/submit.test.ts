import { submitUserFeedback } from './submit';

const mockValues = jest.fn();
const mockTransaction = {
  execute: jest.fn(),
  select: jest.fn(() => ({
    from: () => ({
      where: () => ({ orderBy: () => ({ limit: async () => [] }) }),
    }),
  })),
  insert: jest.fn(() => ({ values: mockValues })),
};

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    transaction: async (callback: (tx: typeof mockTransaction) => Promise<unknown>) =>
      callback(mockTransaction),
  },
}));

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  SLACK_USER_FEEDBACK_WEBHOOK_URL: 'https://hooks.slack.invalid/feedback',
}));

describe('feedback Slack notification', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    mockValues.mockReturnValue({ returning: async () => [{ id: 'feedback-id' }] });
    fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('puts every user field in plain-text blocks with a fixed notification fallback', async () => {
    const hostileText =
      '```\n<https://attacker.invalid|Trusted admin link> <!channel> <@U123>\n' +
      'https://attacker.invalid @here *bold* :smile: &lt;!everyone&gt;';
    const input = {
      userId: 'oauth/feedback-user <!everyone>',
      feedbackText: `  ${hostileText}\n`,
      feedbackFor: '` <!here>',
      feedbackBatch: '` <#C123|general>',
      source: '` <!subteam^S123>',
    };

    await expect(submitUserFeedback(input)).resolves.toEqual({ id: 'feedback-id' });

    expect(mockValues).toHaveBeenCalledWith({
      kilo_user_id: input.userId,
      feedback_text: input.feedbackText,
      feedback_for: input.feedbackFor,
      feedback_batch: input.feedbackBatch,
      source: input.source,
      context_json: {},
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.slack.invalid/feedback',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          text: 'New user feedback',
          mrkdwn: false,
          parse: 'none',
          unfurl_links: false,
          unfurl_media: false,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'plain_text',
                text: [
                  'New user feedback:',
                  `• user: ${input.userId}`,
                  `• for: ${input.feedbackFor}`,
                  `• source: ${input.source}`,
                  `• batch: ${input.feedbackBatch}`,
                  '• raw feedback:',
                  input.feedbackText,
                ].join('\n'),
                emoji: false,
              },
            },
          ],
        }),
      })
    );
  });

  it('keeps defaults and an empty-feedback placeholder', async () => {
    await submitUserFeedback({ userId: 'oauth/feedback-user' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('• raw feedback:\\n<empty>'),
      })
    );
  });

  it('does not fail a saved submission when Slack is unavailable', async () => {
    fetchMock.mockRejectedValue(new Error('Slack unavailable'));
    const consoleMock = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(submitUserFeedback({ userId: 'oauth/feedback-user' })).resolves.toEqual({
      id: 'feedback-id',
    });
    expect(consoleMock).toHaveBeenCalledWith(
      '[UserFeedback] Failed to post to Slack webhook',
      expect.any(Error)
    );
  });
});
