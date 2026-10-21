import { cloudAgentNextFeedbackRouter } from './cloud-agent-next-feedback-router';
import type { User } from '@kilocode/db/schema';
import type * as TRPC from '@trpc/server';

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    insert: () => ({
      values: () => ({ returning: async () => [{ id: 'feedback-id' }] }),
    }),
  },
}));

jest.mock('@kilocode/web-shared/lib/trpc/init', () => {
  const { initTRPC } = jest.requireActual<typeof TRPC>('@trpc/server');
  const t = initTRPC.context<{ user: { id: string } }>().create();
  return { baseProcedure: t.procedure, createTRPCRouter: t.router };
});

jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  SLACK_USER_FEEDBACK_WEBHOOK_URL: 'https://hooks.slack.invalid/feedback',
}));

describe('Cloud Agent feedback Slack notification', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  const caller = cloudAgentNextFeedbackRouter.createCaller({
    user: { id: 'oauth/feedback-user' } as User,
  });

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    [
      'ses_35fc6b339ffeaf91IozzdnLtJ7',
      '<https://app.kilo.ai/admin/session-traces?sessionId=ses_35fc6b339ffeaf91IozzdnLtJ7|ses_35fc6b339ffeaf91IozzdnLtJ7>',
    ],
    [
      'ses_evil&x=1><https://attacker.invalid|<!channel>',
      '<https://app.kilo.ai/admin/session-traces?sessionId=ses_evil%26x%3D1%3E%3Chttps%3A%2F%2Fattacker.invalid%7C%3C!channel%3E|ses_evil&amp;x=1&gt;&lt;https://attacker.invalid|&lt;!channel&gt;>',
    ],
    [undefined, '_unknown_'],
  ])('keeps session %s inside the trusted admin link', async (sessionId, expectedLink) => {
    const feedback = '``` <https://attacker.invalid|admin> <!channel> :smile:';
    await caller.create({ kilo_session_id: sessionId, feedback_text: feedback });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.slack.invalid/feedback',
      expect.objectContaining({
        body: JSON.stringify({
          text: 'New Cloud Agent feedback',
          unfurl_links: false,
          unfurl_media: false,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: '*New Cloud Agent feedback:* :robot_face:' },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `• session: ${expectedLink}\n• session type: _unknown_`,
                verbatim: true,
              },
            },
            { type: 'section', text: { type: 'mrkdwn', text: '• feedback:' } },
            {
              type: 'section',
              text: { type: 'plain_text', text: feedback, emoji: false },
            },
          ],
        }),
      })
    );
  });
});
