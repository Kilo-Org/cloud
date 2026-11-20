import { env, evictAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { sessionDoName } from '../../src/session-identity.js';

type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;
const OWNER_ID = 'user_stored_skill';

/**
 * The DO keeps its state private; this test reads the parsed registration the
 * storage layer restored, which no public RPC exposes without a sandbox peer.
 */
type SessionState = {
  registration: { spec: { runtimeSkills?: unknown } } | null;
};

const STORED_SKILLS = [
  {
    name: 'review',
    rawMarkdown: '# Review',
    files: { 'legacy/./notes.md': 'legacy', 'scripts/run.sh': 'echo ok' },
  },
];
const ACCEPTED_SKILLS = [
  { name: 'review', rawMarkdown: '# Review', files: { 'scripts/run.sh': 'echo ok' } },
];

async function seedStoredSession(sessionId: string) {
  const stub = sessions.getByName(sessionDoName(OWNER_ID, sessionId));
  // The first access writes the storage generation, so the seeded rows survive
  // the re-read.
  await runInDurableObject(stub, async () => {});
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put('session_metadata', {
      metadataSchemaVersion: 2,
      identity: { userId: OWNER_ID, sessionId },
      auth: {},
      lifecycle: { version: 1, timestamp: 1 },
      profile: { runtimeSkills: STORED_SKILLS },
    });
    await state.storage.put('control_plane_session', {
      sandboxId: 'ses-0123456789abcdef',
      spec: {
        sessionId,
        kiloSessionId: `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`,
        directory: `/workspace/${sessionId}`,
        attemptId: `${sessionId}-requested`,
        runtimeSkills: STORED_SKILLS,
      },
      credentials: {
        userId: OWNER_ID,
        kiloSessionId: `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`,
        kiloToken: 'stored-skill-token',
      },
    });
  });
  await evictAllDurableObjects();
  return stub;
}

describe('stored session with a companion file the current path rule rejects', () => {
  it('keeps the stored metadata and drops only the rejected entry', async () => {
    const sessionId = `workspace_${crypto.randomUUID()}`;
    const stub = await seedStoredSession(sessionId);

    const metadata = await stub.getMetadata();
    expect(metadata?.identity).toMatchObject({ userId: OWNER_ID, sessionId });
    expect(metadata?.profile?.runtimeSkills).toEqual(ACCEPTED_SKILLS);
  });

  it('keeps the stored registration and drops only the rejected entry', async () => {
    const sessionId = `workspace_${crypto.randomUUID()}`;
    const stub = await seedStoredSession(sessionId);

    const registration = await runInDurableObject(stub, instance => {
      const { registration } = instance as unknown as SessionState;
      return registration;
    });
    expect(registration?.spec.runtimeSkills).toEqual(ACCEPTED_SKILLS);
  });
});
