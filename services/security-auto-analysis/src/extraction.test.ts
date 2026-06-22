import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecurityFindingRecord } from './db/queries.js';
import { extractSandboxAnalysis } from './extraction.js';

const finding = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  package_name: 'example-package',
  package_ecosystem: 'npm',
  severity: 'high',
  dependency_scope: 'runtime',
  cve_id: 'CVE-2026-1234',
  ghsa_id: 'GHSA-1234-5678',
  title: 'Example vulnerability',
  vulnerable_version_range: '<2.0.0',
  patched_version: '2.0.0',
} as SecurityFindingRecord;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractSandboxAnalysis', () => {
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
                    name: 'submit_analysis_extraction',
                    arguments: JSON.stringify({
                      isExploitable: true,
                      exploitabilityReasoning: 'Vulnerable package is reachable at runtime.',
                      usageLocations: ['src/server.ts'],
                      suggestedFix: 'Upgrade example-package to 2.0.0.',
                      suggestedAction: 'open_pr',
                      summary: 'Runtime path reaches vulnerable package.',
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

    const result = await extractSandboxAnalysis({
      finding,
      rawMarkdown: '# Analysis',
      authToken: 'test-token',
      model: 'kilo-auto/balanced',
      backendBaseUrl: 'http://localhost:3000',
    });

    const requestBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(requestBody.tool_choice).toBe('auto');
    expect(requestBody.tools[0].function.name).toBe('submit_analysis_extraction');
    expect(result).toMatchObject({
      isExploitable: true,
      extractionStatus: 'succeeded',
      suggestedAction: 'open_pr',
      modelUsed: 'kilo-auto/balanced',
    });
  });

  it('normalizes boolean strings returned in tool arguments', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    type: 'function',
                    function: {
                      name: 'submit_analysis_extraction',
                      arguments: JSON.stringify({
                        isExploitable: 'false',
                        exploitabilityReasoning: 'Package is not used.',
                        usageLocations: [],
                        suggestedFix: 'Remove the package.',
                        suggestedAction: 'dismiss',
                        summary: 'Unused package is not exploitable.',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        })
      )
    );

    const result = await extractSandboxAnalysis({
      finding,
      rawMarkdown: '# Analysis',
      authToken: 'test-token',
      model: 'kilo-auto/balanced',
      backendBaseUrl: 'http://localhost:3000',
    });

    expect(result).toMatchObject({
      isExploitable: false,
      extractionStatus: 'succeeded',
      suggestedAction: 'dismiss',
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
                content: `\`\`\`json
{"isExploitable":false,"exploitabilityReasoning":"Package is not used.","usageLocations":[],"suggestedFix":"Remove the package.","suggestedAction":"dismiss","summary":"Unused package is not exploitable."}
\`\`\``,
              },
            },
          ],
        })
      )
    );

    const result = await extractSandboxAnalysis({
      finding,
      rawMarkdown: '# Analysis',
      authToken: 'test-token',
      model: 'kilo-auto/balanced',
      backendBaseUrl: 'http://localhost:3000',
    });

    expect(result).toMatchObject({
      isExploitable: false,
      extractionStatus: 'succeeded',
      suggestedAction: 'dismiss',
      modelUsed: 'kilo-auto/balanced',
    });
  });

  it('keeps the conservative fallback for malformed content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          choices: [{ message: { content: 'The package appears safe.' } }],
        })
      )
    );

    const result = await extractSandboxAnalysis({
      finding,
      rawMarkdown: '# Analysis',
      authToken: 'test-token',
      model: 'kilo-auto/balanced',
      backendBaseUrl: 'http://localhost:3000',
    });

    expect(result).toMatchObject({
      isExploitable: 'unknown',
      extractionStatus: 'failed',
      suggestedAction: 'manual_review',
    });
  });

  it('marks fallback output when structured extraction request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    const result = await extractSandboxAnalysis({
      finding,
      rawMarkdown: '# Analysis\n\nPackage is not used.',
      authToken: 'test-token',
      model: 'kilo-auto/balanced',
      backendBaseUrl: 'http://localhost:3000',
    });

    expect(result).toMatchObject({
      isExploitable: 'unknown',
      extractionStatus: 'failed',
      suggestedAction: 'manual_review',
      summary: 'Analysis completed but structured extraction failed. Review raw output.',
    });
  });
});
