import { describe, expect, it } from 'bun:test';
import type { ControlPlaneWrapperFrame } from '../../../src/shared/control-plane-protocol.js';
import { createHistoryRequests } from './history-requests.js';

const request = { sessionId: 'workspace_1', kiloSessionId: `ses_${'a'.repeat(26)}` };

function setup() {
  const sent: ControlPlaneWrapperFrame[] = [];
  const requests = createHistoryRequests({ send: frame => sent.push(frame) });
  const requestId = () => {
    const frame = sent.at(-1);
    if (frame?.type !== 'history.page') throw new Error('expected history.page');
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

describe('history requests', async () => {
  it('sends one page request and resolves its result', async () => {
    const { sent, requests, requestId } = setup();
    const page = requests.readPage({ ...request, cursor: 'next' });
    expect(sent).toEqual([
      { type: 'history.page', requestId: requestId(), ...request, cursor: 'next' },
    ]);
    requests.handle({ type: 'history.result', requestId: 'other', ok: true, page: 'foreign' });
    requests.handle({ type: 'history.result', requestId: requestId(), ok: true, page: 'page' });
    expect(await page).toBe('page');
  });

  it('rejects a failed result with its code', async () => {
    const { requests, requestId } = setup();
    const page = requests.readPage(request);
    requests.handle({
      type: 'history.result',
      requestId: requestId(),
      ok: false,
      error: { code: 'not_found', message: 'missing', retryable: false },
    });
    expect(await rejection(page)).toContain('History read failed: not_found');
  });

  it('fails every waiting page when the connection closes', async () => {
    const { requests } = setup();
    const pages = [requests.readPage(request), requests.readPage(request)];
    requests.disconnected();
    for (const page of pages) expect(await rejection(page)).toContain('Control connection closed');
    // A settled request no longer counts toward the bound.
    for (let index = 0; index < 16; index += 1) void requests.readPage(request).catch(() => {});
    expect(await rejection(requests.readPage(request))).toContain(
      'Too many history reads are waiting'
    );
    requests.disconnected();
  });

  it('stops waiting when the caller aborts', async () => {
    const { requests } = setup();
    const abort = new AbortController();
    const page = requests.readPage({ ...request, signal: abort.signal });
    abort.abort();
    expect(await rejection(page)).toContain('History read was aborted');
  });
});
