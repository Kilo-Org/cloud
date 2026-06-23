import { CLOUD_AGENT_PROMPT_MAX_LENGTH } from '@/lib/cloud-agent/constants';
import {
  appendCodeReviewAnalyticsPromptAppendix,
  CODE_REVIEW_ANALYTICS_CHANGE_TYPE_LABELS,
  CODE_REVIEW_ANALYTICS_IMPACT_POINTS,
  CODE_REVIEW_ANALYTICS_MARKER_PREFIX,
  CODE_REVIEW_ANALYTICS_MARKER_SUFFIX,
  CODE_REVIEW_ANALYTICS_MAX_FINDINGS,
  CODE_REVIEW_ANALYTICS_MAX_MANIFEST_UTF8_BYTES,
  CODE_REVIEW_ANALYTICS_PROMPT_APPENDIX,
  CODE_REVIEW_ANALYTICS_SCHEMA_VERSION,
  CODE_REVIEW_ANALYTICS_TAXONOMY_VERSION,
  CodeReviewAnalyticsManifestSchema,
  getCodeReviewAnalyticsImpactPoints,
  parseCodeReviewAnalyticsManifest,
  type CodeReviewAnalyticsManifest,
} from './contracts';

function manifest(
  change: CodeReviewAnalyticsManifest['change'] = {
    type: 'bug_fix',
    impact: 'high',
    complexity: 'medium',
    confidence: 'high',
  },
  findings: CodeReviewAnalyticsManifest['findings'] = []
): CodeReviewAnalyticsManifest {
  return {
    schemaVersion: CODE_REVIEW_ANALYTICS_SCHEMA_VERSION,
    taxonomyVersion: CODE_REVIEW_ANALYTICS_TAXONOMY_VERSION,
    change,
    findings,
  };
}

function marker(value: unknown): string {
  return `${CODE_REVIEW_ANALYTICS_MARKER_PREFIX}${JSON.stringify(value)}${CODE_REVIEW_ANALYTICS_MARKER_SUFFIX}`;
}

describe('CodeReviewAnalyticsManifestSchema', () => {
  it('accepts valid empty and populated manifests', () => {
    expect(CodeReviewAnalyticsManifestSchema.parse(manifest()).findings).toEqual([]);

    const populated = manifest(undefined, [
      { severity: 'critical', category: 'security', securityClass: 'auth_access' },
      { severity: 'warning', category: 'correctness', securityClass: null },
      { severity: 'suggestion', category: 'test_quality', securityClass: null },
    ]);
    expect(CodeReviewAnalyticsManifestSchema.parse(populated)).toEqual(populated);
  });

  it('allows change type and impact to vary independently', () => {
    expect(
      CodeReviewAnalyticsManifestSchema.safeParse(
        manifest({
          type: 'bug_fix',
          impact: 'high',
          complexity: 'high',
          confidence: 'high',
        })
      ).success
    ).toBe(true);
    expect(
      CodeReviewAnalyticsManifestSchema.safeParse(
        manifest({
          type: 'feature',
          impact: 'low',
          complexity: 'low',
          confidence: 'medium',
        })
      ).success
    ).toBe(true);
  });

  it('rejects unsupported taxonomy values and versions', () => {
    expect(
      CodeReviewAnalyticsManifestSchema.safeParse({
        ...manifest(),
        schemaVersion: 2,
      }).success
    ).toBe(false);
    expect(
      CodeReviewAnalyticsManifestSchema.safeParse({
        ...manifest(),
        taxonomyVersion: 2,
      }).success
    ).toBe(false);
    expect(
      CodeReviewAnalyticsManifestSchema.safeParse({
        ...manifest(),
        change: { ...manifest().change, type: 'migration' },
      }).success
    ).toBe(false);

    const unsupportedSeverityManifest: unknown = {
      ...manifest(),
      findings: [{ severity: 'blocker', category: 'correctness', securityClass: null }],
    };
    expect(CodeReviewAnalyticsManifestSchema.safeParse(unsupportedSeverityManifest).success).toBe(
      false
    );
  });

  it('rejects text, path, line, code, and other unknown fields at every level', () => {
    expect(
      CodeReviewAnalyticsManifestSchema.safeParse({
        ...manifest(),
        assistantOutput: 'raw output',
      }).success
    ).toBe(false);
    expect(
      CodeReviewAnalyticsManifestSchema.safeParse({
        ...manifest(),
        change: { ...manifest().change, explanation: 'high reach' },
      }).success
    ).toBe(false);
    expect(
      CodeReviewAnalyticsManifestSchema.safeParse({
        ...manifest(),
        findings: [
          {
            severity: 'warning',
            category: 'correctness',
            securityClass: null,
            title: 'Incorrect branch',
            path: 'src/example.ts',
            line: 42,
            code: 'return false',
          },
        ],
      }).success
    ).toBe(false);
  });

  it('requires a security class exactly for security findings', () => {
    expect(
      CodeReviewAnalyticsManifestSchema.safeParse(
        manifest(undefined, [{ severity: 'critical', category: 'security', securityClass: null }])
      ).success
    ).toBe(false);

    const nonSecurityWithClass: unknown = {
      ...manifest(),
      findings: [{ severity: 'warning', category: 'correctness', securityClass: 'injection' }],
    };
    expect(CodeReviewAnalyticsManifestSchema.safeParse(nonSecurityWithClass).success).toBe(false);
  });

  it('rejects more than 100 findings', () => {
    const finding = { severity: 'warning', category: 'reliability', securityClass: null } as const;
    expect(
      CodeReviewAnalyticsManifestSchema.safeParse(
        manifest(
          undefined,
          Array.from({ length: CODE_REVIEW_ANALYTICS_MAX_FINDINGS }, () => finding)
        )
      ).success
    ).toBe(true);
    expect(
      CodeReviewAnalyticsManifestSchema.safeParse(
        manifest(
          undefined,
          Array.from({ length: CODE_REVIEW_ANALYTICS_MAX_FINDINGS + 1 }, () => finding)
        )
      ).success
    ).toBe(false);
  });
});

describe('parseCodeReviewAnalyticsManifest', () => {
  it('captures an exact marker on the final non-empty line', () => {
    const expected = manifest(undefined, [
      { severity: 'warning', category: 'correctness', securityClass: null },
    ]);
    const result = parseCodeReviewAnalyticsManifest(
      `Review publication complete.\n${marker(expected)}\n \t\n`
    );

    expect(result).toEqual({ status: 'captured', manifest: expected });
  });

  it('distinguishes missing, invalid, and explicitly omitted output', () => {
    expect(parseCodeReviewAnalyticsManifest('Review publication complete.')).toEqual({
      status: 'missing',
    });
    expect(
      parseCodeReviewAnalyticsManifest(
        `${CODE_REVIEW_ANALYTICS_MARKER_PREFIX}{not-json}${CODE_REVIEW_ANALYTICS_MARKER_SUFFIX}`
      )
    ).toEqual({ status: 'invalid' });
    expect(parseCodeReviewAnalyticsManifest(undefined, { assistantTextWasOmitted: true })).toEqual({
      status: 'omitted',
    });
  });

  it('rejects unsupported, malformed, and tail-misplaced markers', () => {
    const validMarker = marker(manifest());
    const unsupportedMarker = validMarker.replace(
      '<!-- kilo-review-analytics:v1 ',
      '<!-- kilo-review-analytics:v2 '
    );

    expect(parseCodeReviewAnalyticsManifest(unsupportedMarker)).toEqual({ status: 'invalid' });
    expect(parseCodeReviewAnalyticsManifest(` ${validMarker}`)).toEqual({ status: 'invalid' });
    expect(parseCodeReviewAnalyticsManifest(`${validMarker} trailing`)).toEqual({
      status: 'invalid',
    });
    expect(parseCodeReviewAnalyticsManifest(`${validMarker}\nMore assistant prose.`)).toEqual({
      status: 'missing',
    });
    expect(parseCodeReviewAnalyticsManifest(`Prose ${validMarker}`)).toEqual({
      status: 'missing',
    });
  });

  it('rejects manifests over 16 KiB using UTF-8 byte length', () => {
    const multibyteText = '\u{1f600}'.repeat(
      Math.ceil(CODE_REVIEW_ANALYTICS_MAX_MANIFEST_UTF8_BYTES / 4)
    );
    const oversizedMarker = marker({ ...manifest(), code: multibyteText });

    expect(oversizedMarker.length).toBeLessThan(CODE_REVIEW_ANALYTICS_MAX_MANIFEST_UTF8_BYTES);
    expect(new TextEncoder().encode(oversizedMarker).byteLength).toBeGreaterThan(
      CODE_REVIEW_ANALYTICS_MAX_MANIFEST_UTF8_BYTES
    );
    expect(parseCodeReviewAnalyticsManifest(oversizedMarker)).toEqual({ status: 'invalid' });
  });

  it('never returns parser source text', () => {
    const sourceText = `private-source-sentinel\n${marker(manifest())}`;
    const result = parseCodeReviewAnalyticsManifest(sourceText);

    expect(JSON.stringify(result)).not.toContain('private-source-sentinel');
    expect(result).not.toHaveProperty('sourceText');
  });
});

describe('analytics prompt contract', () => {
  it('appends the server-owned appendix after publication instructions', () => {
    const basePrompt = 'Publish every inline comment and summary.';
    const appended = appendCodeReviewAnalyticsPromptAppendix(basePrompt);

    expect(appended).not.toBeNull();
    expect(appended?.indexOf(basePrompt)).toBe(0);
    expect(appended?.endsWith(CODE_REVIEW_ANALYTICS_PROMPT_APPENDIX)).toBe(true);
    expect(appended).toContain('final non-empty line');
    expect(appended).toContain('exclude existing platform comments');
    expect(appended).toContain('carried forward from a previous review');
    expect(appended).toContain('Do not include finding text or prose');
    expect(appended).toContain('path, file path, symbol, line, line range, code, code excerpt');
    expect(appended).toContain(
      marker(
        manifest(undefined, [{ severity: 'warning', category: 'correctness', securityClass: null }])
      )
    );
  });

  it('refuses to exceed the shared Cloud Agent prompt limit', () => {
    const maximumBaseLength =
      CLOUD_AGENT_PROMPT_MAX_LENGTH - CODE_REVIEW_ANALYTICS_PROMPT_APPENDIX.length - 2;

    expect(appendCodeReviewAnalyticsPromptAppendix('x'.repeat(maximumBaseLength))).not.toBeNull();
    expect(appendCodeReviewAnalyticsPromptAppendix('x'.repeat(maximumBaseLength + 1))).toBeNull();
  });

  it('exports stable labels, versions, and impact points', () => {
    expect(CODE_REVIEW_ANALYTICS_SCHEMA_VERSION).toBe(1);
    expect(CODE_REVIEW_ANALYTICS_TAXONOMY_VERSION).toBe(1);
    expect(CODE_REVIEW_ANALYTICS_CHANGE_TYPE_LABELS.bug_fix).toBe('Bug fix');
    expect(CODE_REVIEW_ANALYTICS_IMPACT_POINTS).toEqual({ low: 1, medium: 2, high: 3 });
    expect(getCodeReviewAnalyticsImpactPoints('high', 'high')).toBe(3);
    expect(getCodeReviewAnalyticsImpactPoints('high', 'low')).toBe(0);
  });
});
