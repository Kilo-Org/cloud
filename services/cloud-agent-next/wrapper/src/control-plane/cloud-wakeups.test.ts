import { expect, it } from 'bun:test';
import type { ControlPlaneRouteSpec } from '../../../src/shared/control-plane-protocol.js';
import { createWrapperWakeups } from './cloud-wakeups.js';

it('authenticates loopback calls and maps only registered root sessions', async () => {
  const spec = {
    sessionId: 'cloud-root',
    kiloSessionId: 'kilo-root',
    cloudWakeup: 'snapshot',
  } as ControlPlaneRouteSpec;
  const seen: string[] = [];
  const wakeups = createWrapperWakeups({
    clear: () => undefined,
    send: frame => {
      if (frame.type !== 'wakeup.request') throw new Error('unexpected frame');
      seen.push(frame.sessionId);
      wakeups.result({
        type: 'wakeup.result',
        requestId: frame.requestId,
        result: { ok: false, error: 'durable response' },
      });
    },
  });
  try {
    const installed = await wakeups.environment(spec, 'workspace', {});
    const { options } = JSON.parse(installed.KILO_CLOUD_WAKEUP_PLUGIN ?? 'null');
    wakeups.register(spec, 'workspace');
    const schedule = (sessionID: string, secret: string) =>
      fetch(options.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          sessionID,
          command: { action: 'schedule', callId: '1', delay: '20s', prompt: 'Read the report' },
        }),
      });
    expect((await schedule('kilo-root', '0'.repeat(43))).status).toBe(403);
    expect((await schedule('unknown-or-child', options.secret)).status).toBe(403);
    expect(await (await schedule('kilo-root', options.secret)).json()).toEqual({
      ok: false,
      error: 'durable response',
    });
    expect(seen).toEqual(['cloud-root']);
  } finally {
    await wakeups.stop();
  }
});
