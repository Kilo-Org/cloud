import { env, reset, runInDurableObject, SELF } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSecret } from '../../src/auth.js';
import { allocation as allocationTable } from '../../src/control-plane/sandbox/sqlite-schema.js';
import {
  mintSandboxLaunchCredential,
  verifySandboxLaunchCredential,
} from '../../src/sandbox-control/credential.js';
import {
  PREVIEW_MARKER_ALLOCATION_HEADER,
  PREVIEW_MARKER_PORT_HEADER,
} from '../../src/shared/preview-headers.js';
import {
  previewRequest,
  previewTunnelStub,
  tunnelPeerFrom,
} from './helpers/preview-tunnel-peer.js';
import {
  readSandboxAlarm,
  startTunnelSandbox,
  type TunnelSandbox,
} from './helpers/preview-tunnel-sandbox.js';

afterEach(async () => {
  await reset();
});

function connect(sandboxId: string, headers: Record<string, string>): Promise<Response> {
  return SELF.fetch(`http://worker.test/sandbox-preview-tunnel/${encodeURIComponent(sandboxId)}`, {
    headers,
  });
}

function bearer(token: string): Record<string, string> {
  return { Upgrade: 'websocket', Authorization: `Bearer ${token}` };
}

async function signingSecret(): Promise<string> {
  const secret = await resolveSecret(env.NEXTAUTH_SECRET);
  if (!secret) throw new Error('Test signing secret unavailable');
  return secret;
}

/** The raw credential behind the sandbox's launch token, for tokens with changed claims. */
async function rawCredential(sandbox: TunnelSandbox): Promise<string> {
  const launch = verifySandboxLaunchCredential(sandbox.launchCredential, await signingSecret());
  if (launch === null) throw new Error('The launch credential did not verify');
  return launch.credential;
}

/** One browser request through the tunnel; proves that `peer` is the current tunnel. */
async function expectCurrentTunnel(sandbox: TunnelSandbox, response: Response): Promise<void> {
  const peer = tunnelPeerFrom(response);
  const tunnel = previewTunnelStub(sandbox.sandboxId, sandbox.allocationId);
  const pending = tunnel.fetch(previewRequest('/', { allocationId: sandbox.allocationId }));
  const open = await peer.takeType('open');
  peer.respond(open.stream, 200, 'through the admitted tunnel');
  expect(await (await pending).text()).toBe('through the admitted tunnel');
  expect(sandbox.demands()).toBe(0);
}

describe('Preview tunnel admission', () => {
  it('admits the current allocation, and forged preview markers do not change the connect', async () => {
    const sandbox = await startTunnelSandbox({ previewTunnel: true });
    const alarm = await readSandboxAlarm(sandbox.stub);
    const activity = (await sandbox.stub.getAllocationState()).lastActivityAt;
    const response = await connect(sandbox.sandboxId, {
      ...bearer(sandbox.launchCredential),
      [PREVIEW_MARKER_PORT_HEADER]: '3000',
      [PREVIEW_MARKER_ALLOCATION_HEADER]: sandbox.allocationId,
    });
    await expectCurrentTunnel(sandbox, response);
    expect((await sandbox.stub.getAllocationState()).lastActivityAt).toBe(activity);
    expect(await readSandboxAlarm(sandbox.stub)).toBe(alarm);
    sandbox.wrapper.close();
  });

  it('refuses a request that is not an upgrade, has a bad sandbox id or has no bearer', async () => {
    const sandbox = await startTunnelSandbox({ previewTunnel: true });
    const token = sandbox.launchCredential;
    expect((await connect(sandbox.sandboxId, { Authorization: `Bearer ${token}` })).status).toBe(
      426
    );
    expect((await connect('not valid', bearer(token))).status).toBe(400);
    expect((await connect(sandbox.sandboxId, { Upgrade: 'websocket' })).status).toBe(401);
    sandbox.wrapper.close();
  });

  it.each([
    { name: 'a token signed with another key', claims: 'forged' },
    { name: 'a token for another sandbox', claims: 'other_sandbox' },
    { name: 'a stale allocation', claims: 'stale_allocation' },
    { name: 'a wrong credential', claims: 'wrong_credential' },
  ] as const)('refuses $name with 403', async ({ claims }) => {
    const sandbox = await startTunnelSandbox({ previewTunnel: true });
    const secret = await signingSecret();
    const valid = {
      sandboxId: sandbox.sandboxId,
      allocationId: sandbox.allocationId,
      credential: await rawCredential(sandbox),
    };
    const token =
      claims === 'forged'
        ? mintSandboxLaunchCredential(valid, 'another-signing-key')
        : claims === 'other_sandbox'
          ? mintSandboxLaunchCredential({ ...valid, sandboxId: 'sbx_other' }, secret)
          : claims === 'stale_allocation'
            ? mintSandboxLaunchCredential({ ...valid, allocationId: crypto.randomUUID() }, secret)
            : mintSandboxLaunchCredential({ ...valid, credential: 'b'.repeat(64) }, secret);
    const response = await connect(sandbox.sandboxId, bearer(token));
    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
    sandbox.wrapper.close();
  });

  it('refuses a connect for a stopping allocation', async () => {
    const sandbox = await startTunnelSandbox({ previewTunnel: true });
    await runInDurableObject(sandbox.stub, async (_instance, state) => {
      await drizzle(state.storage)
        .update(allocationTable)
        .set({ state: 'stopping' })
        .where(eq(allocationTable.id, 'current'));
    });
    expect((await sandbox.stub.getAllocationState()).kind).toBe('stopping');
    expect((await connect(sandbox.sandboxId, bearer(sandbox.launchCredential))).status).toBe(403);
    sandbox.wrapper.close();
  });

  it('refuses a connect for a stopped allocation', async () => {
    const sandbox = await startTunnelSandbox({ previewTunnel: true });
    await sandbox.stub.reportProviderGone();
    expect((await sandbox.stub.getAllocationState()).kind).toBe('stopped');
    expect((await connect(sandbox.sandboxId, bearer(sandbox.launchCredential))).status).toBe(403);
    sandbox.wrapper.close();
  });
});
