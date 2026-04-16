import type {
  AuditFinding,
  SecurityAdvisorRequest,
  ReportFinding,
  Recommendation,
  RecommendationPriority,
  FindingSeverity,
} from './schemas';
import { findCoverageForCheckId, type LoadedSecurityAdvisorContent } from './content-loader';

// --- Report generation ---

interface GenerateReportOptions {
  audit: SecurityAdvisorRequest['audit'];
  publicIp?: string;
  /** If true, omit KiloClaw comparison text (for KiloClaw-sourced requests) */
  isKiloClaw: boolean;
  /** All customer-visible strings. Loaded via getSecurityAdvisorContent(). */
  content: LoadedSecurityAdvisorContent;
}

interface GeneratedReport {
  markdown: string;
  summary: { critical: number; warn: number; info: number; passed: number };
  findings: ReportFinding[];
  recommendations: Recommendation[];
}

export function generateSecurityReport(options: GenerateReportOptions): GeneratedReport {
  const { audit, publicIp, isKiloClaw, content } = options;

  const findings = audit.findings.map(f => mapFinding(f, isKiloClaw, content));
  const recommendations = generateRecommendations(findings, content);

  // Count passed deep-scan checks. Only deep scan results have a clear pass/fail
  // signal (ok: true/false). Standard findings only report failures, so we can't
  // infer how many standard checks passed. When no deep scan was run, passed is 0.
  const deepChecks = audit.deep ? Object.values(audit.deep) : [];
  const passed = deepChecks.filter(
    check => typeof check === 'object' && check !== null && 'ok' in check && check.ok === true
  ).length;

  // Recompute severity counts from server-mapped findings, not client-reported
  // summary. Server may have overridden severity for known checkIds, so the
  // client's counts can't be trusted.
  const summary = {
    critical: findings.filter(f => f.severity === 'critical').length,
    warn: findings.filter(f => f.severity === 'warn').length,
    info: findings.filter(f => f.severity === 'info').length,
    passed,
  };

  const markdown = renderMarkdown({
    findings,
    recommendations,
    summary,
    publicIp,
    isKiloClaw,
    content,
  });

  return { markdown, summary, findings, recommendations };
}

function mapFinding(
  finding: AuditFinding,
  isKiloClaw: boolean,
  content: LoadedSecurityAdvisorContent
): ReportFinding {
  const catalogEntry = content.checkCatalog.get(finding.checkId);
  const coverage = findCoverageForCheckId(finding.checkId, content.kiloclawCoverage);

  // Server-assigned severity for known checkIds; client-reported for unknown
  const severity = catalogEntry?.severity ?? finding.severity;

  return {
    checkId: finding.checkId,
    severity,
    title: finding.title,
    explanation: catalogEntry?.explanation ?? finding.detail,
    risk:
      catalogEntry?.risk ??
      interpolate(getContent(content, 'fallback.risk', 'Review this finding: {detail}'), {
        detail: finding.detail,
      }),
    fix: finding.remediation ?? null,
    kiloClawComparison: formatCoverage(coverage, isKiloClaw, content),
  };
}

function formatCoverage(
  coverage: { summary: string; detail: string } | null,
  isKiloClaw: boolean,
  content: LoadedSecurityAdvisorContent
): string | null {
  if (!coverage) return null;

  const template = isKiloClaw
    ? getContent(
        content,
        'framing.kiloclaw',
        '**KiloClaw default:** {summary}. Your instance has diverged.'
      )
    : getContent(content, 'framing.openclaw', '**How KiloClaw handles this:** {summary}. {detail}');

  return interpolate(template, {
    summary: coverage.summary,
    detail: coverage.detail,
  });
}

function generateRecommendations(
  findings: ReportFinding[],
  content: LoadedSecurityAdvisorContent
): Recommendation[] {
  const recommendations: Recommendation[] = [];
  const seen = new Set<string>();

  const fallbackActionTemplate = getContent(
    content,
    'fallback.recommendation_action',
    'Address finding: {title} ({checkId})'
  );

  for (const finding of findings) {
    if (finding.severity === 'info') continue;
    if (seen.has(finding.checkId)) continue;
    seen.add(finding.checkId);

    const priority = severityToPriority(finding.severity);
    const action =
      finding.fix ??
      interpolate(fallbackActionTemplate, {
        title: finding.title,
        checkId: finding.checkId,
      });

    recommendations.push({ priority, action });
  }

  // Sort: immediate first, then high, medium, low
  const priorityOrder: Record<RecommendationPriority, number> = {
    immediate: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return recommendations;
}

function severityToPriority(severity: FindingSeverity): RecommendationPriority {
  switch (severity) {
    case 'critical':
      return 'immediate';
    case 'warn':
      return 'high';
    case 'info':
      return 'low';
  }
}

// --- Markdown rendering ---

interface RenderOptions {
  findings: ReportFinding[];
  recommendations: Recommendation[];
  summary: { critical: number; warn: number; info: number; passed: number };
  publicIp?: string;
  isKiloClaw: boolean;
  content: LoadedSecurityAdvisorContent;
}

function renderMarkdown(opts: RenderOptions): string {
  const { findings, recommendations, summary, publicIp, isKiloClaw, content } = opts;
  const get = (key: string, fallback: string) => getContent(content, key, fallback);
  const lines: string[] = [];

  // Header
  lines.push('# Security Audit Report');
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  const parts: string[] = [];
  if (summary.critical > 0) {
    parts.push(`**${summary.critical} critical**`);
  }
  if (summary.warn > 0) {
    parts.push(`${summary.warn} warning${summary.warn !== 1 ? 's' : ''}`);
  }
  if (summary.info > 0) {
    parts.push(`${summary.info} informational`);
  }
  if (summary.passed > 0) {
    parts.push(`${summary.passed} passed`);
  }
  lines.push(parts.join(' | '));
  lines.push('');

  if (publicIp) {
    lines.push(`**Public IP:** \`${publicIp}\``);
    lines.push('');
  }

  // Critical findings
  const critical = findings.filter(f => f.severity === 'critical');
  if (critical.length > 0) {
    lines.push('## Critical Findings');
    lines.push('');
    for (const f of critical) {
      renderFinding(lines, f);
    }
  }

  // Warnings
  const warnings = findings.filter(f => f.severity === 'warn');
  if (warnings.length > 0) {
    lines.push('## Warnings');
    lines.push('');
    for (const f of warnings) {
      renderFinding(lines, f);
    }
  }

  // Info
  const info = findings.filter(f => f.severity === 'info');
  if (info.length > 0) {
    lines.push('## Informational');
    lines.push('');
    for (const f of info) {
      renderFinding(lines, f);
    }
  }

  // Recommendations
  if (recommendations.length > 0) {
    lines.push('## Recommendations');
    lines.push('');
    for (const rec of recommendations) {
      lines.push(`- [${rec.priority.toUpperCase()}] ${rec.action}`);
    }
    lines.push('');
  }

  // CTA for non-KiloClaw users. Rendered as a top-level heading + bold
  // paragraph (not a blockquote) so capable models treat it as structural
  // report content and preserve it when reformatting. Small summarizing
  // models will paraphrase regardless; the /security-checkup slash command
  // bypasses the LLM entirely for those.
  if (!isKiloClaw) {
    lines.push('---');
    lines.push('');
    lines.push(get('section.next_step', '## Next step: try KiloClaw free'));
    lines.push('');
    lines.push(
      get(
        'cta.body',
        '**Want these issues handled automatically?** Start a free trial at [kilo.ai/kiloclaw](https://kilo.ai/kiloclaw).'
      )
    );
    lines.push('');
  }

  return lines.join('\n');
}

function renderFinding(lines: string[], finding: ReportFinding): void {
  lines.push(`### ${finding.title}`);
  lines.push('');
  lines.push(`**Check:** \`${finding.checkId}\``);
  lines.push('');
  lines.push(finding.explanation);
  lines.push('');
  lines.push(`**Risk:** ${finding.risk}`);
  lines.push('');

  if (finding.fix) {
    lines.push(`**Fix:** \`${finding.fix}\``);
    lines.push('');
  }

  if (finding.kiloClawComparison) {
    lines.push(finding.kiloClawComparison);
    lines.push('');
  }
}

// --- Helpers ---

function getContent(content: LoadedSecurityAdvisorContent, key: string, fallback: string): string {
  return content.content.get(key) ?? fallback;
}

/**
 * Replace `{name}` placeholders in `template` with the corresponding values.
 * Values are coerced to strings. Placeholders without a matching value are
 * left as-is so copy-editors can diagnose missing interpolations visually.
 */
function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    return Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match;
  });
}
