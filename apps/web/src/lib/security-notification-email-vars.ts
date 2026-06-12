import { RawHtml, escapeHtml } from '@/lib/email';

type SecurityFindingEmailVarsInput = {
  severity: string;
  repositoryName: string;
  findingTitle: string;
  description: string | null;
  cveId: string | null;
  ghsaId: string | null;
  cvssScore: string | number | null;
  actionUrl: string;
  slaDeadline?: string;
};

type TemplateVars = Record<string, string | RawHtml>;

const severityStyles = {
  critical: { color: '#991b1b', background: '#fee2e2', border: '#fecaca' },
  high: { color: '#9a3412', background: '#ffedd5', border: '#fed7aa' },
  medium: { color: '#854d0e', background: '#fef3c7', border: '#fde68a' },
  low: { color: '#166534', background: '#dcfce7', border: '#bbf7d0' },
} as const;

function formatCvssScore(score: string | number | null): string | null {
  if (score === null || score === '') return null;
  const parsed = Number(score);
  if (!Number.isFinite(parsed)) return null;
  return parsed.toFixed(1);
}

function metadataRow(label: string, value: string): string {
  return `<tr>
    <td style="padding: 8px 0; color: #777; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.02em; vertical-align: top; width: 112px">${escapeHtml(label)}</td>
    <td style="padding: 8px 0; color: #333; font-size: 13px; line-height: 1.5; vertical-align: top">${value}</td>
  </tr>`;
}

function severityPill(severity: string, cvssScore: string | null): string {
  const normalizedSeverity = severity.toLowerCase();
  const style =
    severityStyles[normalizedSeverity as keyof typeof severityStyles] ?? severityStyles.medium;
  const score = cvssScore
    ? ` <span style="opacity: 0.78">CVSS ${escapeHtml(cvssScore)}</span>`
    : '';
  return `<span style="display: inline-block; border: 1px solid ${style.border}; border-radius: 999px; background: ${style.background}; color: ${style.color}; font-size: 12px; font-weight: 700; line-height: 1; padding: 5px 8px; text-transform: capitalize">${escapeHtml(normalizedSeverity)}${score}</span>`;
}

function buildFindingDetails(input: SecurityFindingEmailVarsInput): RawHtml {
  const cve = input.cveId ? escapeHtml(input.cveId.toUpperCase()) : 'Not reported';
  const ghsa = input.ghsaId ? escapeHtml(input.ghsaId.toUpperCase()) : 'Not reported';
  const rows = [
    metadataRow('Repository', escapeHtml(input.repositoryName)),
    metadataRow('Severity', severityPill(input.severity, formatCvssScore(input.cvssScore))),
    metadataRow('CVE', cve),
    metadataRow('GHSA', ghsa),
    ...(input.slaDeadline ? [metadataRow('SLA deadline', escapeHtml(input.slaDeadline))] : []),
  ].join('');

  return new RawHtml(`<table width="100%" cellpadding="0" cellspacing="0">${rows}</table>`);
}

export function securityFindingTemplateVars(input: SecurityFindingEmailVarsInput): TemplateVars {
  return {
    severity: input.severity,
    repository_name: input.repositoryName,
    finding_title: input.findingTitle,
    finding_description: input.description?.trim() || 'No description provided.',
    finding_details: buildFindingDetails(input),
    sla_deadline: input.slaDeadline ?? '',
    action_url: input.actionUrl,
  };
}
