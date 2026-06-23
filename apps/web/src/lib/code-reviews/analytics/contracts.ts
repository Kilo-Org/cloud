import {
  CODE_REVIEW_ANALYTICS_SCHEMA_VERSION,
  CODE_REVIEW_ANALYTICS_TAXONOMY_VERSION,
  CodeReviewAnalyticsCaptureStatus,
  CodeReviewAnalyticsChangeType,
  CodeReviewAnalyticsClassificationConfidence,
  CodeReviewAnalyticsComplexityLevel,
  CodeReviewAnalyticsImpactLevel,
  CodeReviewFindingCategory,
  CodeReviewFindingSecurityClass,
  CodeReviewFindingSeverity,
} from '@kilocode/db/schema-types';
import { z } from 'zod';
import { CLOUD_AGENT_PROMPT_MAX_LENGTH } from '@/lib/cloud-agent/constants';

export {
  CODE_REVIEW_ANALYTICS_SCHEMA_VERSION,
  CODE_REVIEW_ANALYTICS_TAXONOMY_VERSION,
  CodeReviewAnalyticsCaptureStatus,
};

export const CODE_REVIEW_ANALYTICS_MAX_MANIFEST_UTF8_BYTES = 16 * 1024;
export const CODE_REVIEW_ANALYTICS_MAX_FINDINGS = 100;

export const CodeReviewAnalyticsCaptureStatusSchema = z.enum(CodeReviewAnalyticsCaptureStatus);

export const CodeReviewAnalyticsChangeTypeSchema = z.enum(CodeReviewAnalyticsChangeType);
export const CodeReviewAnalyticsImpactLevelSchema = z.enum(CodeReviewAnalyticsImpactLevel);
export const CodeReviewAnalyticsComplexityLevelSchema = z.enum(CodeReviewAnalyticsComplexityLevel);
export const CodeReviewAnalyticsClassificationConfidenceSchema = z.enum(
  CodeReviewAnalyticsClassificationConfidence
);
export const CodeReviewFindingSeveritySchema = z.enum(CodeReviewFindingSeverity);
export const CodeReviewFindingCategorySchema = z.enum(CodeReviewFindingCategory);
export const CodeReviewFindingSecurityClassSchema = z.enum(CodeReviewFindingSecurityClass);

export const CodeReviewAnalyticsChangeSchema = z
  .object({
    type: CodeReviewAnalyticsChangeTypeSchema,
    impact: CodeReviewAnalyticsImpactLevelSchema,
    complexity: CodeReviewAnalyticsComplexityLevelSchema,
    confidence: CodeReviewAnalyticsClassificationConfidenceSchema,
  })
  .strict();

export const CodeReviewAnalyticsFindingSchema = z
  .object({
    severity: CodeReviewFindingSeveritySchema,
    category: CodeReviewFindingCategorySchema,
    securityClass: CodeReviewFindingSecurityClassSchema.nullable(),
  })
  .strict()
  .superRefine((finding, context) => {
    const isSecurity = finding.category === 'security';
    if (isSecurity === (finding.securityClass !== null)) return;

    context.addIssue({
      code: 'custom',
      message: isSecurity
        ? 'securityClass is required for security findings'
        : 'securityClass must be null for non-security findings',
      path: ['securityClass'],
    });
  });

export const CodeReviewAnalyticsManifestSchema = z
  .object({
    schemaVersion: z.literal(CODE_REVIEW_ANALYTICS_SCHEMA_VERSION),
    taxonomyVersion: z.literal(CODE_REVIEW_ANALYTICS_TAXONOMY_VERSION),
    change: CodeReviewAnalyticsChangeSchema,
    findings: z.array(CodeReviewAnalyticsFindingSchema).max(CODE_REVIEW_ANALYTICS_MAX_FINDINGS),
  })
  .strict();

export type CodeReviewAnalyticsChange = z.infer<typeof CodeReviewAnalyticsChangeSchema>;
export type CodeReviewAnalyticsFinding = z.infer<typeof CodeReviewAnalyticsFindingSchema>;
export type CodeReviewAnalyticsManifest = z.infer<typeof CodeReviewAnalyticsManifestSchema>;

export type CodeReviewAnalyticsManifestParseResult =
  | {
      status: 'captured';
      manifest: CodeReviewAnalyticsManifest;
    }
  | {
      status: 'missing' | 'invalid' | 'omitted';
    };

export type ParseCodeReviewAnalyticsManifestOptions = {
  assistantTextWasOmitted?: boolean;
};

export const CODE_REVIEW_ANALYTICS_MARKER_PREFIX = '<!-- kilo-review-analytics:v1 ';
export const CODE_REVIEW_ANALYTICS_MARKER_SUFFIX = ' -->';

const CODE_REVIEW_ANALYTICS_MARKER_PROTOCOL_PREFIX = '<!-- kilo-review-analytics:';
const utf8Encoder = new TextEncoder();

function getFinalNonEmptyLine(sourceText: string): string | undefined {
  const lines = sourceText.split(/\r\n|\n|\r/);
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
    lines.pop();
  }
  return lines.at(-1);
}

export function parseCodeReviewAnalyticsManifest(
  sourceText: string | null | undefined,
  options: ParseCodeReviewAnalyticsManifestOptions = {}
): CodeReviewAnalyticsManifestParseResult {
  if (options.assistantTextWasOmitted) {
    return { status: CodeReviewAnalyticsCaptureStatus.Omitted };
  }

  if (!sourceText) {
    return { status: CodeReviewAnalyticsCaptureStatus.Missing };
  }

  const markerLine = getFinalNonEmptyLine(sourceText);
  if (!markerLine) {
    return { status: CodeReviewAnalyticsCaptureStatus.Missing };
  }

  if (
    !markerLine.startsWith(CODE_REVIEW_ANALYTICS_MARKER_PREFIX) ||
    !markerLine.endsWith(CODE_REVIEW_ANALYTICS_MARKER_SUFFIX)
  ) {
    const markerLikeTail = markerLine
      .trimStart()
      .startsWith(CODE_REVIEW_ANALYTICS_MARKER_PROTOCOL_PREFIX);
    return {
      status: markerLikeTail
        ? CodeReviewAnalyticsCaptureStatus.Invalid
        : CodeReviewAnalyticsCaptureStatus.Missing,
    };
  }

  const serializedManifest = markerLine.slice(
    CODE_REVIEW_ANALYTICS_MARKER_PREFIX.length,
    -CODE_REVIEW_ANALYTICS_MARKER_SUFFIX.length
  );
  if (
    utf8Encoder.encode(serializedManifest).byteLength >
    CODE_REVIEW_ANALYTICS_MAX_MANIFEST_UTF8_BYTES
  ) {
    return { status: CodeReviewAnalyticsCaptureStatus.Invalid };
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(serializedManifest);
  } catch {
    return { status: CodeReviewAnalyticsCaptureStatus.Invalid };
  }

  const parsed = CodeReviewAnalyticsManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    return { status: CodeReviewAnalyticsCaptureStatus.Invalid };
  }

  return {
    status: CodeReviewAnalyticsCaptureStatus.Captured,
    manifest: parsed.data,
  };
}

export const CODE_REVIEW_ANALYTICS_CHANGE_TYPE_LABELS = {
  bug_fix: 'Bug fix',
  feature: 'Feature',
  refactor: 'Refactor',
  maintenance: 'Maintenance',
  dependency: 'Dependency',
  test: 'Test',
  documentation: 'Documentation',
  mixed: 'Mixed',
  other: 'Other',
} as const satisfies Record<CodeReviewAnalyticsChangeType, string>;

export const CODE_REVIEW_ANALYTICS_IMPACT_LEVEL_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
} as const satisfies Record<CodeReviewAnalyticsImpactLevel, string>;

export const CODE_REVIEW_ANALYTICS_COMPLEXITY_LEVEL_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
} as const satisfies Record<CodeReviewAnalyticsComplexityLevel, string>;

export const CODE_REVIEW_ANALYTICS_CLASSIFICATION_CONFIDENCE_LABELS = {
  low: 'Low confidence',
  medium: 'Medium confidence',
  high: 'High confidence',
} as const satisfies Record<CodeReviewAnalyticsClassificationConfidence, string>;

export const CODE_REVIEW_FINDING_SEVERITY_LABELS = {
  critical: 'Critical',
  warning: 'Warning',
  suggestion: 'Suggestion',
} as const satisfies Record<CodeReviewFindingSeverity, string>;

export const CODE_REVIEW_FINDING_CATEGORY_LABELS = {
  security: 'Security',
  correctness: 'Correctness',
  reliability: 'Reliability',
  data_integrity: 'Data integrity',
  performance: 'Performance',
  compatibility: 'Compatibility',
  maintainability: 'Maintainability',
  test_quality: 'Test quality',
  documentation: 'Documentation',
  accessibility: 'Accessibility',
  other: 'Other',
} as const satisfies Record<CodeReviewFindingCategory, string>;

export const CODE_REVIEW_FINDING_SECURITY_CLASS_LABELS = {
  auth_access: 'Authentication and access',
  injection: 'Injection',
  data_protection: 'Data protection',
  request_resource_boundary: 'Request and resource boundaries',
  deserialization_object_integrity: 'Deserialization and object integrity',
  dependency_supply_chain: 'Dependency and supply chain',
  memory_safety: 'Memory safety',
  availability: 'Availability',
  concurrency: 'Concurrency',
  security_configuration: 'Security configuration',
  other: 'Other',
} as const satisfies Record<CodeReviewFindingSecurityClass, string>;

export const CODE_REVIEW_ANALYTICS_IMPACT_POINTS = {
  low: 1,
  medium: 2,
  high: 3,
} as const satisfies Record<CodeReviewAnalyticsImpactLevel, number>;

export function getCodeReviewAnalyticsImpactPoints(
  impact: CodeReviewAnalyticsImpactLevel,
  confidence: CodeReviewAnalyticsClassificationConfidence
): number {
  return confidence === 'low' ? 0 : CODE_REVIEW_ANALYTICS_IMPACT_POINTS[impact];
}

const changeTypes = Object.values(CodeReviewAnalyticsChangeType).join(' | ');
const impactLevels = Object.values(CodeReviewAnalyticsImpactLevel).join(' | ');
const complexityLevels = Object.values(CodeReviewAnalyticsComplexityLevel).join(' | ');
const confidenceLevels = Object.values(CodeReviewAnalyticsClassificationConfidence).join(' | ');
const findingSeverities = Object.values(CodeReviewFindingSeverity).join(' | ');
const findingCategories = Object.values(CodeReviewFindingCategory).join(' | ');
const securityClasses = Object.values(CodeReviewFindingSecurityClass).join(' | ');
const exampleManifest = JSON.stringify({
  schemaVersion: CODE_REVIEW_ANALYTICS_SCHEMA_VERSION,
  taxonomyVersion: CODE_REVIEW_ANALYTICS_TAXONOMY_VERSION,
  change: {
    type: CodeReviewAnalyticsChangeType.BugFix,
    impact: CodeReviewAnalyticsImpactLevel.High,
    complexity: CodeReviewAnalyticsComplexityLevel.Medium,
    confidence: CodeReviewAnalyticsClassificationConfidence.High,
  },
  findings: [
    {
      severity: CodeReviewFindingSeverity.Warning,
      category: CodeReviewFindingCategory.Correctness,
      securityClass: null,
    },
  ],
} satisfies CodeReviewAnalyticsManifest);

export const CODE_REVIEW_ANALYTICS_PROMPT_APPENDIX = `# CODE REVIEW ANALYTICS MANIFEST

After completing every review and publication instruction above, emit exactly one analytics marker as the final non-empty line of your assistant response. The marker line must contain no leading or trailing text and must use this exact wrapper:

<!-- kilo-review-analytics:v1 ${exampleManifest} -->

The JSON must be a single object with exactly these keys and shapes:
- schemaVersion: exactly ${CODE_REVIEW_ANALYTICS_SCHEMA_VERSION}
- taxonomyVersion: exactly ${CODE_REVIEW_ANALYTICS_TAXONOMY_VERSION}
- change: exactly type, impact, complexity, and confidence
- findings: an array of at most ${CODE_REVIEW_ANALYTICS_MAX_FINDINGS} objects, each with exactly severity, category, and securityClass

Allowed change.type values: ${changeTypes}
Allowed change.impact values: ${impactLevels}
Allowed change.complexity values: ${complexityLevels}
Allowed change.confidence values: ${confidenceLevels}
Allowed finding.severity values: ${findingSeverities}
Allowed finding.category values: ${findingCategories}
Allowed finding.securityClass values: ${securityClasses}

Classification rules:
- Impact measures reach and consequence, not diff size or change type. A one-line authentication fix can be high impact, while a large generated feature can be low impact.
- Complexity measures the technical difficulty and risk of implementing the change. Complexity never adds impact points.
- Change type is descriptive and never weighted. Bug fixes and features can independently have low, medium, or high impact.
- Use low confidence when the available evidence does not support a reliable classification. Low-confidence impact contributes no impact points.
- Include only Code Review Findings newly raised during this execution. In incremental reviews, exclude existing platform comments and every finding carried forward from a previous review into the summary.
- Use securityClass as a non-null allowed security class exactly when category is security. For every other category, securityClass must be null.
- A review with no newly raised findings must use an empty findings array. The marker is still required.
- Do not include finding text or prose. Do not add title, explanation, suggested fix, raw comment, path, file path, symbol, line, line range, code, code excerpt, prompt, assistant output, or any other key at any nesting level. The schemas are strict and reject unknown keys.
- Keep the JSON manifest at or below ${CODE_REVIEW_ANALYTICS_MAX_MANIFEST_UTF8_BYTES} UTF-8 bytes.
- This exact marker must be the final non-empty assistant line. Do not put prose, code fences, or any other content after it.`;

function promptAppendixSeparator(prompt: string): string {
  if (prompt.endsWith('\n\n')) return '';
  return prompt.endsWith('\n') ? '\n' : '\n\n';
}

export function appendCodeReviewAnalyticsPromptAppendix(prompt: string): string | null {
  const appendedPrompt = `${prompt}${promptAppendixSeparator(prompt)}${CODE_REVIEW_ANALYTICS_PROMPT_APPENDIX}`;
  return appendedPrompt.length <= CLOUD_AGENT_PROMPT_MAX_LENGTH ? appendedPrompt : null;
}
