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
  manageNotificationsUrl: string;
  slaDeadline?: string;
};

type TemplateVars = Record<string, string | RawHtml>;

const severityStyles = {
  critical: { color: '#991b1b', background: '#fee2e2', border: '#fecaca' },
  high: { color: '#9a3412', background: '#ffedd5', border: '#fed7aa' },
  medium: { color: '#854d0e', background: '#fef3c7', border: '#fde68a' },
  low: { color: '#166534', background: '#dcfce7', border: '#bbf7d0' },
} as const;

function githubRepositoryUrl(repositoryName: string): string {
  return `https://github.com/${repositoryName
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/')}`;
}

function cveUrl(cveId: string): string | null {
  if (!/^CVE-\d{4}-\d{4,}$/i.test(cveId)) return null;
  return `https://www.cve.org/CVERecord?id=${encodeURIComponent(cveId.toUpperCase())}`;
}

function ghsaUrl(ghsaId: string): string | null {
  if (!/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/i.test(ghsaId)) return null;
  return `https://github.com/advisories/${encodeURIComponent(ghsaId.toUpperCase())}`;
}

function formatCvssScore(score: string | number | null): string | null {
  if (score === null || score === '') return null;
  const parsed = Number(score);
  if (!Number.isFinite(parsed)) return null;
  return parsed.toFixed(1);
}

function metadataLink(label: string, href: string | null): string {
  const safeLabel = escapeHtml(label);
  if (!href) return safeLabel;
  return `<a href="${escapeHtml(href)}" style="color: #1a1a1a; text-decoration: underline">${safeLabel}</a>`;
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
  const repositoryUrl = githubRepositoryUrl(input.repositoryName);
  const cve = input.cveId ? metadataLink(input.cveId, cveUrl(input.cveId)) : 'Not reported';
  const ghsa = input.ghsaId ? metadataLink(input.ghsaId, ghsaUrl(input.ghsaId)) : 'Not reported';
  const rows = [
    metadataRow('Repository', metadataLink(input.repositoryName, repositoryUrl)),
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
    manage_notifications_url: input.manageNotificationsUrl,
  };
}
