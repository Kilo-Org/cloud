import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { SandboxStatusDO } from '../do/sandbox-status-do';

function getStub(sandboxId: string): DurableObjectStub<SandboxStatusDO> {
  const id = env.SANDBOX_STATUS_DO.idFromName(sandboxId);
  return env.SANDBOX_STATUS_DO.get(id);
}

describe('SandboxStatusDO bot_status capabilities column', () => {
  it('persists capabilities through put + read', async () => {
    const stub = getStub('cap-probe');
    await stub.putBotStatus({ online: true, at: 1000, capabilities: ['attachments'] });
    const status = await stub.getBotStatus();
    expect(status?.capabilities).toEqual(['attachments']);
  });

  it('returns undefined capabilities when the row has none', async () => {
    const stub = getStub('cap-probe-empty');
    await stub.putBotStatus({ online: true, at: 1000 });
    const status = await stub.getBotStatus();
    expect(status?.capabilities).toBeUndefined();
  });
});
