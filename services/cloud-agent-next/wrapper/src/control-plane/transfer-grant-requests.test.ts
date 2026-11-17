import { describe, expect, it } from 'bun:test';
import type { ControlPlaneWrapperFrame } from '../../../src/shared/control-plane-protocol.js';
import { createTransferGrantRequests } from './transfer-grant-requests.js';

function setup() {
  const sent: ControlPlaneWrapperFrame[] = [];
  const requests = createTransferGrantRequests({ send: frame => sent.push(frame) });
  const requestId = () => {
    const frame = sent.at(-1);
    if (frame?.type !== 'transfer.grant') throw new Error('expected transfer.grant');
    return frame.requestId;
  };
  return { sent, requests, requestId };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => undefined,
    (failure: unknown) => failure
  );
  if (!(error instanceof Error)) throw new Error('expected a rejection');
  return error.message;
}

describe('transfer grant requests', () => {
  it('sends one request and resolves its grant', async () => {
    const { sent, requests, requestId } = setup();
    const grant = requests.requestGrant();
    expect(sent).toEqual([{ type: 'transfer.grant', requestId: requestId() }]);
    requests.handle({
      type: 'transfer.grant.result',
      requestId: 'other',
      ok: true,
      grant: 'foreign',
      expiresAt: 1,
    });
    requests.handle({
      type: 'transfer.grant.result',
      requestId: requestId(),
      ok: true,
      grant: 'grant-value',
      expiresAt: 2,
    });
    expect(await grant).toEqual({ grant: 'grant-value', expiresAt: 2 });
  });

  it('rejects a failed result with its code', async () => {
    const { requests, requestId } = setup();
    const grant = requests.requestGrant();
    requests.handle({
      type: 'transfer.grant.result',
      requestId: requestId(),
      ok: false,
      error: { code: 'not_ready', message: 'missing', retryable: true },
    });
    expect(await rejection(grant)).toContain('Transfer grant renewal failed: not_ready');
  });

  it('fails every waiting request when the connection closes', async () => {
    const { requests } = setup();
    const grants = [requests.requestGrant(), requests.requestGrant()];
    requests.disconnected();
    for (const grant of grants)
      expect(await rejection(grant)).toContain('Control connection closed');
    for (let index = 0; index < 4; index += 1) void requests.requestGrant().catch(() => undefined);
    expect(await rejection(requests.requestGrant())).toContain(
      'Too many transfer grant renewals are waiting'
    );
    requests.disconnected();
  });

  it('stops waiting when the caller aborts', async () => {
    const { requests } = setup();
    const abort = new AbortController();
    const grant = requests.requestGrant({ signal: abort.signal });
    abort.abort();
    expect(await rejection(grant)).toContain('Transfer grant renewal was aborted');
  });
});
