import { db } from '@/lib/drizzle';
import { cliSessions, cli_sessions_v2 } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { resolveCloudAgentSessionIds } from './webhook-session-resolution';

describe('resolveCloudAgentSessionIds', () => {
  const testUserId = `test-user-webhook-res-${crypto.randomUUID()}`;
  const v1SessionIds: string[] = [];
  const v2SessionIds: string[] = [];

  beforeAll(async () => {
    await insertTestUser({ id: testUserId });
  });

  afterAll(async () => {
    if (v2SessionIds.length > 0) {
      await db.delete(cli_sessions_v2).where(inArray(cli_sessions_v2.session_id, v2SessionIds));
    }
    if (v1SessionIds.length > 0) {
      await db.delete(cliSessions).where(inArray(cliSessions.session_id, v1SessionIds));
    }
  });

  it('returns empty map for empty input', async () => {
    const result = await resolveCloudAgentSessionIds([]);
    expect(result).toEqual(new Map());
  });

  it('resolves all IDs from v1 without querying v2', async () => {
    const cloudId1 = crypto.randomUUID();
    const cloudId2 = crypto.randomUUID();

    const [s1] = await db
      .insert(cliSessions)
      .values({
        kilo_user_id: testUserId,
        title: 'v1 session 1',
        cloud_agent_session_id: cloudId1,
      })
      .returning({ session_id: cliSessions.session_id });

    const [s2] = await db
      .insert(cliSessions)
      .values({
        kilo_user_id: testUserId,
        title: 'v1 session 2',
        cloud_agent_session_id: cloudId2,
      })
      .returning({ session_id: cliSessions.session_id });

    v1SessionIds.push(s1.session_id, s2.session_id);

    const result = await resolveCloudAgentSessionIds([cloudId1, cloudId2]);

    expect(result.size).toBe(2);
    expect(result.get(cloudId1)).toBe(s1.session_id);
    expect(result.get(cloudId2)).toBe(s2.session_id);
  });

  it('resolves some IDs from v1 and remainder from v2', async () => {
    const cloudIdV1 = crypto.randomUUID();
    const cloudIdV2 = crypto.randomUUID();

    const [s1] = await db
      .insert(cliSessions)
      .values({
        kilo_user_id: testUserId,
        title: 'v1 session mixed',
        cloud_agent_session_id: cloudIdV1,
      })
      .returning({ session_id: cliSessions.session_id });
    v1SessionIds.push(s1.session_id);

    const v2SessionId = `ses_${crypto.randomUUID()}`;
    await db.insert(cli_sessions_v2).values({
      session_id: v2SessionId,
      kilo_user_id: testUserId,
      cloud_agent_session_id: cloudIdV2,
    });
    v2SessionIds.push(v2SessionId);

    const result = await resolveCloudAgentSessionIds([cloudIdV1, cloudIdV2]);

    expect(result.size).toBe(2);
    expect(result.get(cloudIdV1)).toBe(s1.session_id);
    expect(result.get(cloudIdV2)).toBe(v2SessionId);
  });

  it('returns empty map when IDs are not found in either table', async () => {
    const result = await resolveCloudAgentSessionIds([crypto.randomUUID(), crypto.randomUUID()]);
    expect(result.size).toBe(0);
  });

  it('returns the v1 session_id when same cloud_agent_session_id exists in both tables', async () => {
    const sharedCloudId = crypto.randomUUID();

    const [v1Session] = await db
      .insert(cliSessions)
      .values({
        kilo_user_id: testUserId,
        title: 'v1 priority session',
        cloud_agent_session_id: sharedCloudId,
      })
      .returning({ session_id: cliSessions.session_id });
    v1SessionIds.push(v1Session.session_id);

    const v2SessionId = `ses_${crypto.randomUUID()}`;
    await db.insert(cli_sessions_v2).values({
      session_id: v2SessionId,
      kilo_user_id: testUserId,
      cloud_agent_session_id: sharedCloudId,
    });
    v2SessionIds.push(v2SessionId);

    const result = await resolveCloudAgentSessionIds([sharedCloudId]);

    expect(result.size).toBe(1);
    expect(result.get(sharedCloudId)).toBe(v1Session.session_id);
  });
});
