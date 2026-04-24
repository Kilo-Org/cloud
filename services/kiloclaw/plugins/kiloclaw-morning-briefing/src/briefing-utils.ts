import path from 'node:path';

export type BriefingSourceStatus = {
  source: 'github' | 'linear' | 'web';
  configured: boolean;
  ok: boolean;
  summary: string;
};

export type BriefingDocumentSection = {
  title: string;
  lines: string[];
};

export function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function offsetDays(base: Date, offset: number): Date {
  const copy = new Date(base.getTime());
  copy.setDate(copy.getDate() + offset);
  return copy;
}

export function resolveBriefingPath(briefingsDir: string, date: Date): string {
  return path.join(briefingsDir, `${formatDateKey(date)}.md`);
}

export function buildBriefingMarkdown(params: {
  date: Date;
  generatedAt: Date;
  statuses: BriefingSourceStatus[];
  sections: BriefingDocumentSection[];
  failures: string[];
}): string {
  const dateKey = formatDateKey(params.date);
  const lines: string[] = [];
  lines.push(`# Morning Briefing - ${dateKey}`);

  for (const section of params.sections) {
    if (section.lines.length === 0) {
      continue;
    }
    lines.push('');
    lines.push(`## ${section.title}`);
    lines.push(...section.lines);
  }

  if (params.failures.length > 0) {
    lines.push('');
    lines.push('## Failures / Skipped');
    for (const failure of params.failures) {
      lines.push(`- ${failure}`);
    }
  }

  lines.push('');
  lines.push('## Source Status');
  for (const status of params.statuses) {
    const marker = status.ok ? '[ok]' : status.configured ? '[error]' : '[skipped]';
    lines.push(`- ${status.source}: ${marker} ${status.summary}`);
  }

  lines.push('');
  lines.push(`_Generated at ${params.generatedAt.toISOString()}_`);
  lines.push('');

  return lines.join('\n');
}
