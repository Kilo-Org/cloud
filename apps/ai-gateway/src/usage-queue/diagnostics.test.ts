jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  pool: { totalCount: 0, idleCount: 0, waitingCount: 0, options: { max: 10 } },
}));

import { observeUsageRecordCompletion } from '@kilocode/web-shared/lib/ai-gateway/usage-record-diagnostics';

test('existing writer completion preserves the isolated queue caller and write result', async () => {
  const usage = {
    id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    created_at: '2026-04-29T01:16:12.945Z',
  };
  const recorded = {
    usageId: usage.id,
    createdAt: usage.created_at,
    newMicrodollarsUsed: 1234,
    wasRedelivery: false,
  };
  const info = jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.replaceProperty(process, 'env', { ...process.env, VERCEL_ENV: 'preview' });
  try {
    expect(
      await observeUsageRecordCompletion(usage, async () => recorded, {
        entrypoint: 'writer_endpoint',
        writer_caller: 'queue_vercel',
      })
    ).toBe(recorded);
    expect(JSON.parse(info.mock.calls[0][0])).toMatchObject({
      usage_id: usage.id,
      entrypoint: 'writer_endpoint',
      writer_caller: 'queue_vercel',
    });
  } finally {
    jest.restoreAllMocks();
  }
});
