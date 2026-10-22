import { appBuilderFeedbackRouter } from './app-builder-feedback-router';
import type { User } from '@kilocode/db/schema';
import type * as TRPC from '@trpc/server';

const projectId = '12345678-1234-4234-8234-123456789abc';

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'feedback-id' }] }) }),
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

jest.mock('@/lib/app-builder/app-builder-service', () => ({
  getProjectWithOwnershipCheck: async (id: string) => ({ id, session_id: null }),
}));

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  SLACK_USER_FEEDBACK_WEBHOOK_URL: 'https://hooks.slack.invalid/feedback',
}));

it('renders project IDs and App Builder feedback only in plain-text blocks', async () => {
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
  const feedback = '``` <!channel> <https://attacker.invalid|review> :smile:';

  try {
    const caller = appBuilderFeedbackRouter.createCaller({
      user: { id: 'oauth/feedback-user' } as User,
    });
    await caller.create({ project_id: projectId, feedback_text: feedback });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.slack.invalid/feedback',
      expect.objectContaining({
        body: JSON.stringify({
          text: 'New App Builder feedback',
          unfurl_links: false,
          unfurl_media: false,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'plain_text',
                text: `New App Builder feedback:\n• project: ${projectId}\n• feedback:\n${feedback}`,
                emoji: false,
              },
            },
          ],
        }),
      })
    );
  } finally {
    fetchMock.mockRestore();
  }
});
