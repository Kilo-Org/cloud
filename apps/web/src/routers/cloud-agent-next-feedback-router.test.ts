import { cloudAgentNextFeedbackRouter } from './cloud-agent-next-feedback-router';
import type { User } from '@kilocode/db/schema';
import type * as TRPC from '@trpc/server';

const mockInsert = jest.fn(() => ({
  values: () => ({ returning: async () => [{ id: 'feedback-id' }] }),
}));

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: { insert: () => mockInsert() },
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
    mockInsert.mockClear();
    fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['ses_00000000000000000000000001', 'ses_00000000000000000000000001'],
    [undefined, 'unknown'],
  ])('renders session %s and feedback only as plain text', async (sessionId, expectedSession) => {
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
              text: {
                type: 'plain_text',
                text: `New Cloud Agent feedback:\n• session: ${expectedSession}\n• session type: unknown\n• feedback:\n${feedback}`,
                emoji: false,
              },
            },
          ],
        }),
      })
    );
  });

  it.each([
    { kilo_session_id: 'x><!channel> <!here> <https://attacker.invalid|Review session trace>' },
    { kilo_session_id: 'ses_' + '<'.repeat(26) },
    { kilo_session_id: 'ses_tooShort' },
    { kilo_session_id: '' },
    { cloud_agent_session_id: 'workspace_><!channel>' },
    { cloud_agent_session_id: 'workspace_not-a-uuid' },
    { cloud_agent_session_id: '' },
  ])('rejects invalid session metadata %j before storage or Slack', async metadata => {
    await expect(caller.create({ ...metadata, feedback_text: 'feedback' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'agent_12345678-1234-1234-1234-123456789abc',
    'workspace_12345678-1234-1234-1234-123456789abc',
  ])('accepts existing Cloud Agent ID format %s', async cloudAgentSessionId => {
    await expect(
      caller.create({ cloud_agent_session_id: cloudAgentSessionId, feedback_text: 'feedback' })
    ).resolves.toEqual({ id: 'feedback-id' });
  });

  it.each(['cloud-agent', 'remote', 'read-only'] as const)(
    'accepts %s feedback without requiring a Cloud Agent ID',
    async sessionType => {
      await expect(
        caller.create({
          kilo_session_id: 'ses_00000000000000000000000001',
          session_type: sessionType,
          feedback_text: 'feedback',
        })
      ).resolves.toEqual({ id: 'feedback-id' });
    }
  );
});
