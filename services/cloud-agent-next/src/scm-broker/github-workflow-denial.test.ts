import { describe, expect, it } from 'vitest';
import { workflowPermissionDenial } from './github-workflow-denial.js';
describe('provider workflow permission failures', () => {
  it('reports the unsupported operation without changing unrelated authorization failures', async () => {
    const denied = await workflowPermissionDenial(
      Response.json(
        { message: 'Refusing a workflow update without workflows permission' },
        { status: 403 }
      )
    );
    expect(await denied?.text()).toContain('operation_not_supported: Workflow file changes');
    expect(
      await workflowPermissionDenial(
        Response.json({ message: 'Resource not accessible' }, { status: 403 })
      )
    ).toBeNull();
  });
});

it('preserves a stalled provider response after a bounded inspection interval', async () => {
  const { vi } = await import('vitest');
  vi.useFakeTimers();
  try {
    const original = new Response(new ReadableStream({ start() {} }), { status: 403 });
    const pending = workflowPermissionDenial(original);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toBeNull();
    expect(original.bodyUsed).toBe(false);
    void original.body?.cancel().catch(() => undefined);
  } finally {
    vi.useRealTimers();
  }
});
