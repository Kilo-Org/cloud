import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecurityFindingRecord } from './db/queries.js';
import { triageSecurityFinding } from './triage.js';

const finding = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  package_name: 'example-package',
  package_ecosystem: 'npm',
  severity: 'high',
  dependency_scope: 'runtime',
  cve_id: 'CVE-2026-1234',
  ghsa_id: 'GHSA-1234-5678',
  title: 'Example vulnerability',
  description: 'Example description',
  vulnerable_version_range: '<2.0.0',
  patched_version: '2.0.0',
  manifest_path: 'package.json',
  raw_data: null,
} as SecurityFindingRecord;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('triageSecurityFinding', () => {
  it('uses automatic tool selection for reasoning-model compatibility', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  type: 'function',
                  function: {
                    name: 'submit_triage_result',
                    arguments: JSON.stringify({
                      needsSandboxAnalysis: true,
                      needsSandboxReasoning: 'Runtime dependency requires usage analysis.',
                      suggestedAction: 'analyze_codebase',
                      confidence: 'high',
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await triageSecurityFinding({
      finding,
      authToken: 'test-token',
      model: 'kilo-auto/balanced',
      backendBaseUrl: 'http://localhost:3000',
    });

    const requestBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(requestBody.tool_choice).toBe('auto');
    expect(requestBody.tools[0].function.name).toBe('submit_triage_result');
    expect(result).toMatchObject({
      needsSandboxAnalysis: true,
      suggestedAction: 'analyze_codebase',
      confidence: 'high',
    });
  });

  it('accepts a content-only JSON result when the model does not call the tool', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  needsSandboxAnalysis: true,
                  needsSandboxReasoning: 'Runtime usage determines exploitability.',
                  suggestedAction: 'analyze_codebase',
                  confidence: 'high',
                }),
              },
            },
          ],
        })
      )
    );

    const result = await triageSecurityFinding({
      finding,
      authToken: 'test-token',
      model: 'kilo-auto/balanced',
      backendBaseUrl: 'http://localhost:3000',
    });

    expect(result).toMatchObject({
      needsSandboxAnalysis: true,
      suggestedAction: 'analyze_codebase',
      confidence: 'high',
    });
  });

  it('keeps the conservative fallback for malformed content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          choices: [{ message: { content: 'Result: analyze the codebase.' } }],
        })
      )
    );

    const result = await triageSecurityFinding({
      finding,
      authToken: 'test-token',
      model: 'kilo-auto/balanced',
      backendBaseUrl: 'http://localhost:3000',
    });

    expect(result).toMatchObject({
      needsSandboxAnalysis: true,
      suggestedAction: 'analyze_codebase',
      confidence: 'low',
    });
  });
});
