import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DriverConfig } from '../e2e/client.js';
import {
  bestEffortExportDiagnostic,
  hasUsableSentinelDiff,
  inspectSentinelDiff,
} from '../e2e/session-export-check.js';
import type { ExportDiagnosticResources } from '../e2e/session-export-check.js';

describe('structured session-export diagnostic', () => {
  const input = { sentinelPath: 'sentinel.txt', sentinelContents: 'sentinel-body' };

  it('uses last-write-wins sessionDiff data rather than serialized text', () => {
    expect(
      hasUsableSentinelDiff(
        {
          messages: [
            {
              info: {
                summary: { diffs: [{ file: input.sentinelPath, after: input.sentinelContents }] },
              },
            },
          ],
          sessionDiff: [
            { file: input.sentinelPath, after: 'old' },
            { file: input.sentinelPath, after: input.sentinelContents },
          ],
        },
        input
      )
    ).toBe(true);
    expect(
      hasUsableSentinelDiff(
        { messages: [{ text: `${input.sentinelPath} ${input.sentinelContents}` }] },
        input
      )
    ).toBe(false);
  });

  it('does not fall back to message-summary diffs when non-empty sessionDiff wins', () => {
    expect(
      hasUsableSentinelDiff(
        {
          sessionDiff: [{ file: 'other.txt', after: 'other' }],
          messages: [
            {
              info: {
                summary: { diffs: [{ file: input.sentinelPath, after: input.sentinelContents }] },
              },
            },
          ],
        },
        input
      )
    ).toBe(false);
    expect(
      hasUsableSentinelDiff(
        {
          messages: [
            {
              info: {
                summary: {
                  diffs: [
                    { file: input.sentinelPath, after: 'old' },
                    { file: input.sentinelPath, after: input.sentinelContents },
                  ],
                },
              },
            },
          ],
        },
        input
      )
    ).toBe(true);
  });

  it('does not treat patch text as proof of the restored sentinel contents', () => {
    const replacingPatch = '@@ -1 +1 @@\n-sentinel-body\n+different-body\n';
    expect(
      inspectSentinelDiff(
        { sessionDiff: [{ file: input.sentinelPath, patch: replacingPatch }] },
        input
      )
    ).toBe('unknown');
    expect(
      hasUsableSentinelDiff(
        { sessionDiff: [{ file: input.sentinelPath, patch: replacingPatch }] },
        input
      )
    ).toBe(false);
  });

  it('does not prefer matching after-content over a non-empty patch', () => {
    const replacingPatch = '@@ -1 +1 @@\n-sentinel-body\n+different-body\n';
    expect(
      inspectSentinelDiff(
        {
          sessionDiff: [
            { file: input.sentinelPath, patch: replacingPatch, after: input.sentinelContents },
          ],
        },
        input
      )
    ).toBe('unknown');
    expect(
      hasUsableSentinelDiff(
        {
          sessionDiff: [
            { file: input.sentinelPath, patch: replacingPatch, after: input.sentinelContents },
          ],
        },
        input
      )
    ).toBe(false);
    expect(
      hasUsableSentinelDiff(
        { sessionDiff: [{ file: input.sentinelPath, patch: '', after: input.sentinelContents }] },
        input
      )
    ).toBe(true);
  });
});

describe('bestEffortExportDiagnostic three-way result', () => {
  const sentinelPath = 'sentinel.txt';
  const sentinelContents = 'sentinel-body';
  const messageId = 'msg-1';
  const assistantMarker = 'done-tag';
  const replacingPatch = '@@ -1 +1 @@\n-sentinel-body\n+different-body\n';

  const completedTurn = [
    { info: { role: 'user', id: messageId }, parts: [] },
    {
      info: { role: 'assistant', parentID: messageId, time: { completed: 1 } },
      parts: [{ text: `reply ${assistantMarker}` }],
    },
  ];

  const config: DriverConfig = {
    workerUrl: 'http://localhost:8794',
    user: { id: 'usr_test', email: 'test@example.com', api_token_pepper: 'pepper' },
    nextAuthSecret: 'test-secret',
    gitUrl: 'https://example.com/repo.git',
    model: 'kilo/fake-deterministic',
    fakeLlmUrl: 'http://localhost:8811',
  };

  function resources(): ExportDiagnosticResources {
    return {
      config,
      within: async <T>(_label: string, operation: (signal: AbortSignal) => Promise<T>) =>
        operation(new AbortController().signal),
    };
  }

  let exportBody: unknown;
  const originalBaseUrl = process.env.KILO_SESSION_INGEST_URL;

  beforeEach(() => {
    process.env.KILO_SESSION_INGEST_URL = 'http://localhost:9999';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(exportBody), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalBaseUrl === undefined) delete process.env.KILO_SESSION_INGEST_URL;
    else process.env.KILO_SESSION_INGEST_URL = originalBaseUrl;
  });

  it('resolves to unknown when the export carries a non-empty patch plus matching after', async () => {
    exportBody = {
      messages: completedTurn,
      sessionDiff: [{ file: sentinelPath, patch: replacingPatch, after: sentinelContents }],
    };
    await expect(
      bestEffortExportDiagnostic(resources(), {
        kiloSessionId: 'ses_1',
        sentinelPath,
        sentinelContents,
        messageId,
        assistantMarker,
      })
    ).resolves.toBe('unknown');
  });

  it('resolves to true when the export carries a matching after and no patch', async () => {
    exportBody = {
      messages: completedTurn,
      sessionDiff: [{ file: sentinelPath, after: sentinelContents }],
    };
    await expect(
      bestEffortExportDiagnostic(resources(), {
        kiloSessionId: 'ses_1',
        sentinelPath,
        sentinelContents,
        messageId,
        assistantMarker,
      })
    ).resolves.toBe(true);
  });
});
