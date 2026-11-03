import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { eq } from 'drizzle-orm';

import type { User } from '@kilocode/db/schema';
import { cloud_agent_feedback } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';

const SESSION_ID = 'ses_0123456789abcdef0123456789';

async function rowsFor(userId: string) {
  return db
    .select()
    .from(cloud_agent_feedback)
    .where(eq(cloud_agent_feedback.kilo_user_id, userId));
}

describe('cloudAgentNextFeedback.create', () => {
  let user: User;

  beforeEach(async () => {
    user = await insertTestUser();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stores a submission for a canonical session id', async () => {
    const caller = await createCallerForUser(user.id);

    const result = await caller.cloudAgentNextFeedback.create({
      kilo_session_id: SESSION_ID,
      cloud_agent_session_id: 'workspace_12345678-1234-1234-1234-123456789abc',
      session_type: 'cloud-agent',
      feedback_text: 'the send button did nothing',
    });

    expect(result.id).toBeTruthy();
    const rows = await rowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cloud_agent_session_id: 'workspace_12345678-1234-1234-1234-123456789abc',
      session_type: 'cloud-agent',
      feedback_text: 'the send button did nothing',
    });
  });

  it('accepts a v1 UUID session id', async () => {
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.cloudAgentNextFeedback.create({
        kilo_session_id: '11111111-1111-4111-8111-111111111111',
        feedback_text: 'the diff view flickered',
      })
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('rejects a session id that is not in a canonical session id format', async () => {
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.cloudAgentNextFeedback.create({
        kilo_session_id: '<!channel>|https://example.test',
        feedback_text: 'the send button did nothing',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(await rowsFor(user.id)).toHaveLength(0);
  });

  it('refuses a second submission inside the per-user window', async () => {
    const caller = await createCallerForUser(user.id);

    await caller.cloudAgentNextFeedback.create({ feedback_text: 'first report' });

    await expect(
      caller.cloudAgentNextFeedback.create({ feedback_text: 'second report' })
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: expect.stringContaining('1 submission per minute'),
    });

    expect(await rowsFor(user.id)).toHaveLength(1);
  });
});
