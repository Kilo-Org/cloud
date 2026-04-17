import type {
  AuditFinding,
  SecurityAdvisorRequest,
  ReportFinding,
  Recommendation,
  RecommendationPriority,
  FindingSeverity,
  ReportGrade,
} from './schemas';
import { findCoverageForCheckId, type LoadedSecurityAdvisorContent } from './content-loader';

// --- Grading ---

/**
 * Per-finding score deductions. Critical findings dominate the grade; warnings
 * stack up linearly; info is visibility-only and does not affect the score.
 *
 * This is the first calibration pass — tuned against a real captured audit
 * (7 warnings, 0 critical, 1 info) to land at C. Letter cutoffs follow the
 * US academic 90/80/70/60 convention. Both the weights and the thresholds
 * are tunable; if product wants to adjust the curve, this is the one place
 * to edit. The test suite's hardcoded expected scores will need to move in
 * lockstep — see the "grade computation" describe block.
 */
const SCORE_PENALTY_CRITICAL = 35;
const SCORE_PENALTY_WARN = 4;

function computeGrade(
  criticalCount: number,
  warnCount: number
): { score: number; grade: ReportGrade } {
  const raw = 100 - SCORE_PENALTY_CRITICAL * criticalCount - SCORE_PENALTY_WARN * warnCount;
  const score = Math.max(0, Math.round(raw));
  const grade: ReportGrade =
    score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
  return { score, grade };
}

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
  grade: ReportGrade;
  score: number;
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

  const { score, grade } = computeGrade(summary.critical, summary.warn);

  const markdown = renderMarkdown({
    findings,
    recommendations,
    summary,
    score,
    grade,
    publicIp,
    isKiloClaw,
    content,
  });

  return { markdown, score, grade, summary, findings, recommendations };
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

/**
 * Map the stored RecommendationPriority to the user-facing badge text. The
 * report uses the same severity vocabulary as the "## Critical Findings" /
 * "## Warnings" section headings so the reader sees one consistent label
 * set. Only `immediate` and `high` are produced today — `low` is included
 * because info findings could plausibly earn a recommendation in the future,
 * and `medium` deliberately throws so that any new caller that starts
 * producing medium-priority recommendations has to make a conscious labeling
 * choice rather than silently inheriting `WARNING`.
 */
function priorityBadge(priority: RecommendationPriority): string {
  switch (priority) {
    case 'immediate':
      return 'CRITICAL';
    case 'high':
      return 'WARNING';
    case 'low':
      return 'INFO';
    case 'medium':
      throw new Error(
        '[SecurityAdvisor] priorityBadge: "medium" priority has no defined label yet. Pick one in report-generator.ts before emitting medium-priority recommendations.'
      );
  }
}

// --- Markdown rendering ---

interface RenderOptions {
  findings: ReportFinding[];
  recommendations: Recommendation[];
  summary: { critical: number; warn: number; info: number; passed: number };
  score: number;
  grade: ReportGrade;
  publicIp?: string;
  isKiloClaw: boolean;
  content: LoadedSecurityAdvisorContent;
}

function renderMarkdown(opts: RenderOptions): string {
  const { findings, recommendations, summary, score, grade, publicIp, isKiloClaw, content } = opts;
  const get = (key: string, fallback: string) => getContent(content, key, fallback);
  const lines: string[] = [];

  // Header
  lines.push('# Security Audit Report');
  lines.push('');

  // Overall grade — shown at the top so the user sees a single at-a-glance
  // answer before diving into the finding list.
  lines.push(`## Security Grade: ${grade}`);
  lines.push('');
  lines.push(`**Score:** ${score} / 100`);
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

  // Recommendations — render badges using the same vocabulary as the
  // finding sections ("Critical Findings" / "Warnings") so the user sees
  // one set of words throughout the report instead of two. We map the
  // priority enum (immediate/high/...) to the matching severity label
  // at render time; the structured `priority` field in the response
  // stays as-is for API stability.
  if (recommendations.length > 0) {
    lines.push('## Recommendations');
    lines.push('');
    for (const rec of recommendations) {
      lines.push(`- [${priorityBadge(rec.priority)}] ${rec.action}`);
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
