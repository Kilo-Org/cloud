const mockListWorkerRequests = jest.fn();

jest.mock('@/lib/webhook-agent/webhook-agent-client', () => ({
  listWorkerRequests: (...args: unknown[]) => mockListWorkerRequests(...args),
}));

import { db } from '@kilocode/web-shared/lib/drizzle';
import { createCallerFactory } from '@kilocode/web-shared/lib/trpc/init';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  agent_environment_profiles,
  cliSessions,
  cloud_agent_webhook_triggers,
  organizations,
} from '@kilocode/db/schema';
import { adminWebhookTriggersRouter } from './admin-webhook-triggers-router';
import type { CapturedRequest } from '@/lib/webhook-agent/webhook-agent-client';
import { maskHeaderValue } from '@/lib/webhook-agent/request-projection';

const createCaller = createCallerFactory(adminWebhookTriggersRouter);

describe('admin webhook request policy', () => {
  beforeEach(() => mockListWorkerRequests.mockReset());

  test.each(['user', 'organization'] as const)(
    '%s request access and payload projection follow admin policy',
    async scope => {
      const owner = await insertTestUser();
      const admin = await insertTestUser({ is_admin: true });
      const viewer = await insertTestUser({ is_admin: true, can_view_sessions: true });
      const organizationId = crypto.randomUUID();
      if (scope === 'organization') {
        await db.insert(organizations).values({ id: organizationId, name: 'Webhook test' });
      }
      const profileId = crypto.randomUUID();
      await db.insert(agent_environment_profiles).values({
        id: profileId,
        name: 'Webhook test',
        owned_by_user_id: scope === 'user' ? owner.id : null,
        owned_by_organization_id: scope === 'organization' ? organizationId : null,
      });
      const triggerId = 'request-policy';
      await db.insert(cloud_agent_webhook_triggers).values({
        trigger_id: triggerId,
        user_id: scope === 'user' ? owner.id : null,
        organization_id: scope === 'organization' ? organizationId : null,
        github_repo: 'example/repository',
        profile_id: profileId,
      });
      const cloudAgentSessionId = `agent_${crypto.randomUUID()}`;
      const sessionId = crypto.randomUUID();
      await db.insert(cliSessions).values({
        session_id: sessionId,
        kilo_user_id: owner.id,
        title: 'Webhook test',
        cloud_agent_session_id: cloudAgentSessionId,
      });
      const headerSecret = `caller-credential-${crypto.randomUUID()}`;
      const bodySecret = `payload-content-${crypto.randomUUID()}`;
      const querySecret = `query-credential-${crypto.randomUUID()}`;
      const sourceIp = '198.51.100.7';
      const request: CapturedRequest = {
        id: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:00.000Z',
        method: 'POST',
        path: '/',
        queryString: `signature=${querySecret}`,
        headers: { authorization: headerSecret, 'x-github-event': 'push' },
        body: JSON.stringify({ token: bodySecret }),
        contentType: 'application/json',
        sourceIp,
        startedAt: null,
        completedAt: null,
        processStatus: 'captured',
        cloudAgentSessionId,
        errorMessage: null,
        triggerSource: 'webhook',
      };
      mockListWorkerRequests.mockResolvedValue({ success: true, requests: [request] });
      const input =
        scope === 'user'
          ? { scope, userId: owner.id, triggerId }
          : { scope, organizationId, triggerId };

      await expect(createCaller({ user: admin }).listRequests(input)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(mockListWorkerRequests).not.toHaveBeenCalled();

      const response = await createCaller({ user: viewer }).listRequests(input);

      expect(response).toEqual([
        {
          id: request.id,
          timestamp: request.timestamp,
          method: request.method,
          path: request.path,
          startedAt: null,
          completedAt: null,
          processStatus: 'captured',
          cloudAgentSessionId,
          kiloSessionId: sessionId,
          errorMessage: null,
          triggerSource: 'webhook',
          headers: [
            { name: 'authorization', valueMask: maskHeaderValue(headerSecret) },
            { name: 'x-github-event', valueMask: maskHeaderValue('push') },
          ],
          bodyByteLength: new TextEncoder().encode(request.body).byteLength,
        },
      ]);

      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain(headerSecret);
      expect(serialized).not.toContain(bodySecret);
      expect(serialized).not.toContain(querySecret);
      expect(serialized).not.toContain(sourceIp);
    }
  );
});
