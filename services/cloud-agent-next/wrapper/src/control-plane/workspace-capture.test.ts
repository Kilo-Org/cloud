import { describe, expect, it } from 'bun:test';
import type { ControlPlaneWrapperFrame } from '../../../src/shared/control-plane-protocol.js';
import { createWorkspaceCapture } from './workspace-capture.js';

function setup() {
  const sent: ControlPlaneWrapperFrame[] = [];
  const capture = createWorkspaceCapture({ send: frame => sent.push(frame) });
  return { sent, capture };
}

describe('createWorkspaceCapture', () => {
  it('sends the request and resolves with the answer for that session', async () => {
    const { sent, capture } = setup();

    const pending = capture.request('ses_a', 'abc123', 1_000);
    capture.onCaptured('ses_other', true);
    capture.onCaptured('ses_a', true);

    expect(await pending).toBe(true);
    expect(sent).toEqual([{ type: 'workspace.capture', sessionId: 'ses_a', commit: 'abc123' }]);
  });

  it('reports a capture the DO could not save as false', async () => {
    const { capture } = setup();
    const pending = capture.request('ses_a', undefined, 1_000);
    capture.onCaptured('ses_a', false);
    expect(await pending).toBe(false);
  });

  it('omits an empty commit from the frame', async () => {
    const { sent, capture } = setup();
    const pending = capture.request('ses_a', '', 1_000);
    capture.onCaptured('ses_a', true);
    await pending;
    expect(sent).toEqual([{ type: 'workspace.capture', sessionId: 'ses_a' }]);
  });

  it('gives up at the backstop when no answer arrives', async () => {
    const { capture } = setup();
    expect(await capture.request('ses_a', undefined, 20)).toBe(false);
    // A late answer after the backstop has nothing to settle.
    capture.onCaptured('ses_a', true);
  });

  it('settles a request still waiting when the session asks again', async () => {
    const { capture } = setup();
    const first = capture.request('ses_a', undefined, 1_000);
    const second = capture.request('ses_a', undefined, 1_000);
    expect(await first).toBe(false);
    capture.onCaptured('ses_a', true);
    expect(await second).toBe(true);
  });
});
