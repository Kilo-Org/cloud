import { describe, expect, it, vi } from 'vitest';
import { handleBotStatusRequest } from './webhook/dispatch.js';
import { PLUGIN_CAPABILITIES } from './channel';
import type { KiloChatClient } from './client.js';

describe('PLUGIN_CAPABILITIES', () => {
  it('declares the attachments capability', () => {
    expect(PLUGIN_CAPABILITIES).toEqual(['attachments']);
  });
});

describe('handleBotStatusRequest capability declaration', () => {
  it('includes capabilities: ["attachments"] in the sendBotStatus payload', async () => {
    const sendBotStatus = vi.fn().mockResolvedValue(undefined);
    const fakeClient = { sendBotStatus } as unknown as KiloChatClient;

    await handleBotStatusRequest(fakeClient);

    expect(sendBotStatus).toHaveBeenCalledTimes(1);
    const arg = sendBotStatus.mock.calls[0]?.[0] as {
      online: boolean;
      at: number;
      capabilities: readonly string[];
    };
    expect(arg.online).toBe(true);
    expect(arg.capabilities).toEqual(['attachments']);
  });
});
