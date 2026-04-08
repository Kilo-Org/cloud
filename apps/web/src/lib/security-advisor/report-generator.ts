import type {
  AuditFinding,
  SecurityAdvisorRequest,
  ReportFinding,
  Recommendation,
  RecommendationPriority,
  FindingSeverity,
} from './schemas';
import { findComparisonForCheckId } from './kiloclaw-comparison';

// --- Known checkId explanations ---

interface CheckIdTemplate {
  severity: FindingSeverity;
  explanation: string;
  risk: string;
}

/**
 * Templates for known checkIds. When the audit produces a finding with one of these
 * checkIds, we use the server-assigned severity, explanation, and risk instead of
 * the client-reported values.
 *
 * Server-assigned severity is authoritative for known checkIds. This prevents:
 * - A misconfigured/outdated client binary from downgrading real critical findings
 * - A malicious payload from inflating everything to critical to manipulate the report
 *
 * For unknown checkIds (not in this map), we fall back to client-reported severity
 * since the server has no independent opinion.
 */
const KNOWN_CHECK_TEMPLATES: Record<string, CheckIdTemplate> = {
  'fs.config.perms_world_readable': {
    severity: 'critical',
    explanation:
      'The OpenClaw configuration file is readable by all users on the system. ' +
      'This file typically contains API keys, auth tokens, and other secrets.',
    risk:
      'Any process or user on this machine can read your secrets. ' +
      'A compromised or malicious process gains immediate access to all stored credentials.',
  },
  'fs.config.perms_group_readable': {
    severity: 'warn',
    explanation:
      'The OpenClaw configuration file is readable by users in the same group. ' +
      'This may expose secrets to other services running under the same group.',
    risk:
      'Other processes sharing the group can read stored credentials. ' +
      'This is especially risky on shared hosting or multi-tenant servers.',
  },
  'auth.no_authentication': {
    severity: 'critical',
    explanation:
      'The OpenClaw instance has no authentication configured. ' +
      'Anyone who can reach the gateway can use it without credentials.',
    risk:
      'Unauthorized users can execute commands, access conversations, and consume API credits. ' +
      'This is the highest risk configuration for an internet exposed instance.',
  },
  'net.gateway_exposed': {
    severity: 'warn',
    explanation:
      'The OpenClaw gateway is bound to a non localhost address, making it reachable from the network.',
    risk:
      'Network adjacent attackers can connect directly to the gateway. ' +
      'Combined with weak or no authentication, this enables unauthorized access.',
  },
  'net.gateway_open_to_world': {
    severity: 'critical',
    explanation:
      'The OpenClaw gateway is bound to 0.0.0.0, accepting connections from any IP address.',
    risk:
      'The instance is accessible from the entire internet. Without proper authentication and ' +
      'allow listing, this exposes the instance to brute force attacks, credential stuffing, and abuse.',
  },
  'net.no_tls': {
    severity: 'warn',
    explanation: 'Traffic to the OpenClaw gateway is not encrypted with TLS.',
    risk:
      'API keys, auth tokens, and conversation content are transmitted in plaintext. ' +
      'Anyone on the network path can intercept and read this traffic.',
  },
  'net.no_allowlist': {
    severity: 'warn',
    explanation:
      'No IP allow list is configured. The gateway accepts connections from any source IP.',
    risk:
      'There is no network layer restriction on who can attempt to connect. ' +
      'Authentication is the only barrier to unauthorized access.',
  },
  'secrets.plaintext_in_config': {
    severity: 'critical',
    explanation: 'API keys or secrets are stored in plaintext in the configuration file.',
    risk:
      'If the config file is compromised (via file permission issues, backup exposure, or ' +
      'accidental commit), all secrets are immediately usable by an attacker.',
  },
  'version.outdated': {
    severity: 'warn',
    explanation: 'The OpenClaw version is behind the latest release.',
    risk:
      'Older versions may contain known security vulnerabilities that have been patched in newer releases. ' +
      'Running outdated software increases exposure to known exploits.',
  },
  'summary.attack_surface': {
    severity: 'info',
    explanation:
      'This is a summary of the overall attack surface — network exposure, open ports, ' +
      'and access controls in aggregate.',
    risk: 'A larger attack surface means more potential entry points for attackers.',
  },
};

// --- Report generation ---

interface GenerateReportOptions {
  audit: SecurityAdvisorRequest['audit'];
  publicIp?: string;
  /** If true, omit KiloClaw comparison text (for KiloClaw-sourced requests) */
  isKiloClaw: boolean;
}

interface GeneratedReport {
  markdown: string;
  summary: { critical: number; warn: number; info: number; passed: number };
  findings: ReportFinding[];
  recommendations: Recommendation[];
}

export function generateSecurityReport(options: GenerateReportOptions): GeneratedReport {
  const { audit, publicIp, isKiloClaw } = options;

  const findings = audit.findings.map(f => mapFinding(f, isKiloClaw));
  const recommendations = generateRecommendations(findings);

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

  const markdown = renderMarkdown({ findings, recommendations, summary, publicIp, isKiloClaw });

  return { markdown, summary, findings, recommendations };
}

function mapFinding(finding: AuditFinding, isKiloClaw: boolean): ReportFinding {
  const template = KNOWN_CHECK_TEMPLATES[finding.checkId];
  const comparison = findComparisonForCheckId(finding.checkId);

  // Server-assigned severity for known checkIds; client-reported for unknown
  const severity = template?.severity ?? finding.severity;

  return {
    checkId: finding.checkId,
    severity,
    title: finding.title,
    explanation: template?.explanation ?? finding.detail,
    risk:
      template?.risk ??
      `Your OpenClaw instance reports this finding and should be reviewed: ${finding.detail}`,
    fix: finding.remediation,
    kiloClawComparison: formatComparison(comparison, isKiloClaw),
  };
}

function formatComparison(
  comparison: { summary: string; detail: string } | null,
  isKiloClaw: boolean
): string | null {
  if (!comparison) return null;

  if (isKiloClaw) {
    // Divergence warning: KiloClaw user has a finding that shouldn't exist
    return (
      `**KiloClaw default:** ${comparison.summary}. ` +
      `Your instance has diverged from this default configuration. ` +
      `This may indicate a manual change or misconfiguration that should be reviewed.`
    );
  }

  // Sales comparison: show what KiloClaw provides
  return `**How KiloClaw handles this:** ${comparison.summary}. ${comparison.detail}`;
}

function generateRecommendations(findings: ReportFinding[]): Recommendation[] {
  const recommendations: Recommendation[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    if (finding.severity === 'info') continue;
    if (seen.has(finding.checkId)) continue;
    seen.add(finding.checkId);

    const priority = severityToPriority(finding.severity);
    const action = finding.fix ?? `Address finding: ${finding.title} (${finding.checkId})`;

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
}

function renderMarkdown(opts: RenderOptions): string {
  const { findings, recommendations, summary, publicIp, isKiloClaw } = opts;
  const lines: string[] = [];

  // Header
  lines.push('# Security Audit Report');
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  const parts: string[] = [];
  if (summary.critical > 0) parts.push(`**${summary.critical} critical**`);
  if (summary.warn > 0) parts.push(`${summary.warn} warning${summary.warn !== 1 ? 's' : ''}`);
  if (summary.info > 0) parts.push(`${summary.info} informational`);
  if (summary.passed > 0) parts.push(`${summary.passed} passed`);
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
      const badge = `[${rec.priority.toUpperCase()}]`;
      lines.push(`- ${badge} ${rec.action}`);
    }
    lines.push('');
  }

  // CTA for non-KiloClaw users
  if (!isKiloClaw) {
    lines.push('---');
    lines.push('');
    lines.push(
      '> **Want these issues handled automatically?** ' +
        'KiloClaw manages security configuration, patching, and monitoring out of the box. ' +
        'Start a free trial at [kilo.ai/kiloclaw](https://kilo.ai/kiloclaw).'
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
