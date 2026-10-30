import fs from 'node:fs';
import path from 'node:path';

import { writeJson, type CellRun, type Exec, type RunOutcome } from './capture';
import type { Finding, Rect } from './findings';

export type RunMeta = {
  platform: string;
  device: string;
  matrix: string;
  startedAt: string;
  finishedAt: string;
};

export type Box = { rect: Rect; color: string; label: string };

const COLORS = { error: '#ff2020', warning: '#ffb000' } as const;
export const APP_ID = 'com.kilocode.kiloapp';
export const PROBE_REQUIREMENT =
  'needs a dev build connected to Metro; release builds: use scan --source uiautomator';

export const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
];

export function resolveFont(exists: (file: string) => boolean = fs.existsSync): string | undefined {
  return FONT_CANDIDATES.find(file => exists(file));
}

export function annotateArgs(
  input: string,
  output: string,
  boxes: readonly Box[],
  font: string | undefined
): string[] {
  const args = [input, '-strokewidth', '4'];
  if (font !== undefined) args.push('-font', font, '-pointsize', '32');
  for (const box of boxes) {
    const [x, y, width, height] = box.rect;
    const left = Math.round(x);
    const top = Math.round(y);
    args.push(
      '-fill',
      'none',
      '-stroke',
      box.color,
      '-draw',
      `rectangle ${left},${top} ${Math.round(x + width)},${Math.round(y + height)}`
    );
    if (font !== undefined) {
      args.push(
        '-fill',
        box.color,
        '-stroke',
        'none',
        '-annotate',
        `+${left + 4}+${top + 32}`,
        box.label
      );
    }
  }
  args.push(output);
  return args;
}

// ImageMagick 7 (macOS Homebrew) ships `magick`; ImageMagick 6 (the Ubuntu work image) ships
// `convert` and `montage` with the same arguments. Homebrew ImageMagick 7 has no default font,
// so text needs an explicit font file.
export type ImageTools = {
  annotate: readonly string[];
  montage: readonly string[];
  font: string | undefined;
};

export function imageTools(
  exec: Exec,
  exists: (file: string) => boolean = fs.existsSync
): ImageTools {
  const font = resolveFont(exists);
  try {
    exec('magick', ['-version']);
    return { annotate: ['magick'], montage: ['magick', 'montage'], font };
  } catch {
    return { annotate: ['convert'], montage: ['montage'], font };
  }
}

export function montageArgs(
  entries: readonly { label: string; file: string }[],
  output: string,
  font: string | undefined,
  layout: { tile: string; width: number } = { tile: '4x', width: 360 }
): string[] {
  const images =
    font === undefined
      ? entries.map(entry => entry.file)
      : entries.flatMap(entry => ['-label', entry.label.replaceAll('%', '%%'), entry.file]);
  return [
    ...(font === undefined ? [] : ['-font', font, '-pointsize', '20']),
    ...images,
    '-tile',
    layout.tile,
    '-geometry',
    `${layout.width}x+12+12`,
    '-background',
    '#ffffff',
    output,
  ];
}

const TARGET_SHEET_WIDTH = 540;

export type CollapsedFinding = Finding & { count: number };
export type FindingGroup = { finding: CollapsedFinding; members: Finding[] };

const RELATED_LIMIT = 10;

export function collapseFindings(findings: readonly Finding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const finding of findings) {
    const key = JSON.stringify([
      finding.cell,
      finding.target,
      finding.rule,
      finding.severity,
      finding.element.path.replace(/\[\d+\]/g, ''),
      Math.round(finding.measured * 10) / 10,
    ]);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { finding: { ...finding, count: 1 }, members: [finding] });
      continue;
    }
    group.members.push(finding);
    group.finding.count += 1;
    const related = group.finding.related ?? [];
    if (related.length < RELATED_LIMIT) group.finding.related = [...related, finding.element];
  }
  return [...groups.values()];
}

export function screenBoxes(
  groups: readonly FindingGroup[],
  cell: string,
  target: string,
  pixelRatio: number
): Box[] {
  return groups.flatMap((group, index) =>
    group.members
      .filter(finding => finding.cell === cell && finding.target === target)
      .map(finding => {
        const [x, y, width, height] = finding.element.rect;
        return {
          rect: [x * pixelRatio, y * pixelRatio, width * pixelRatio, height * pixelRatio] as const,
          color: COLORS[finding.severity],
          label: String(index + 1),
        };
      })
  );
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function summarize(findings: readonly Finding[]): { errors: number; warnings: number } {
  const errors = findings.filter(finding => finding.severity === 'error').length;
  return { errors, warnings: findings.length - errors };
}

export function renderReport(
  meta: RunMeta,
  cells: readonly CellRun[],
  groups: readonly FindingGroup[]
): string {
  const findings = groups.map(group => group.finding);
  const lines = [
    '# Design gate report',
    '',
    `Platform: ${meta.platform} · Device: ${meta.device} · Matrix: ${meta.matrix}`,
    `Started: ${meta.startedAt} · Finished: ${meta.finishedAt}`,
    `App: ${APP_ID} (${PROBE_REQUIREMENT})`,
    '',
    '| Cell | Screens | Errors | Warnings |',
    '| --- | --- | --- | --- |',
  ];
  for (const cell of cells) {
    const counts = summarize(findings.filter(finding => finding.cell === cell.id));
    lines.push(`| ${cell.id} | ${cell.screens.length} | ${counts.errors} | ${counts.warnings} |`);
  }
  lines.push(
    '',
    '## Screens',
    '',
    '| Cell | Target | Route | Errors | Warnings |',
    '| --- | --- | --- | --- | --- |'
  );
  for (const cell of cells) {
    for (const screen of cell.screens) {
      const counts = summarize(
        findings.filter(finding => finding.cell === cell.id && finding.target === screen.target)
      );
      lines.push(
        `| ${cell.id} | ${screen.target} | \`${screen.env.route}\` | ${counts.errors} | ${counts.warnings} |`
      );
    }
  }
  lines.push('', '## Findings', '');
  if (findings.length === 0) lines.push('No findings.');
  findings.forEach((finding, index) => {
    const repeat = finding.count > 1 ? ` ×${finding.count}` : '';
    lines.push(
      `${index + 1}. **${finding.severity}** \`${finding.rule}\`${repeat} · ${finding.cell} · ${finding.target} · \`${finding.element.path}\` · measured ${formatNumber(finding.measured)} ${finding.unit} vs expected ${finding.expected} — ${finding.message}`
    );
  });
  return `${lines.join('\n')}\n`;
}

export function recordRestoreError(out: string, message: string): void {
  const file = path.join(out, 'findings.json');
  const findings = JSON.parse(fs.readFileSync(file, 'utf8')) as { run: Record<string, unknown> };
  findings.run.restoreError = message;
  writeJson(file, findings);
}

export function writeArtifacts(args: {
  exec: Exec;
  out: string;
  meta: RunMeta;
  outcome: RunOutcome;
}): string {
  const { exec, out, meta, outcome } = args;
  const groups = collapseFindings(outcome.findings);
  const tools = imageTools(exec);
  const run = (command: readonly string[], rest: readonly string[]) => {
    const [binary = '', ...prefix] = command;
    exec(binary, [...prefix, ...rest]);
  };
  const sheet: { label: string; file: string }[] = [];
  const byTarget = new Map<string, { label: string; file: string }[]>();
  for (const cell of outcome.cells) {
    for (const screen of cell.screens) {
      const annotated = path.join(out, screen.annotated);
      const boxes = screenBoxes(groups, cell.id, screen.target, screen.env.pixelRatio);
      run(
        tools.annotate,
        annotateArgs(path.join(out, screen.screenshot), annotated, boxes, tools.font)
      );
      sheet.push({ label: `${cell.id} · ${screen.target}`, file: annotated });
      const tiles = byTarget.get(screen.target) ?? [];
      tiles.push({ label: cell.id, file: annotated });
      byTarget.set(screen.target, tiles);
    }
  }
  if (sheet.length > 0) {
    run(tools.montage, montageArgs(sheet, path.join(out, 'contact-sheet.png'), tools.font));
  }
  const sheets: { target: string; file: string }[] = [];
  if (byTarget.size > 0) fs.mkdirSync(path.join(out, 'sheets'), { recursive: true });
  for (const [target, tiles] of byTarget) {
    const file = path.join('sheets', `${target}.png`);
    run(
      tools.montage,
      montageArgs(tiles, path.join(out, file), tools.font, {
        tile: `${tiles.length}x1`,
        width: TARGET_SHEET_WIDTH,
      })
    );
    sheets.push({ target, file });
  }
  writeJson(path.join(out, 'findings.json'), {
    version: 1,
    run: { ...meta, sheets },
    cells: outcome.cells.map(cell => ({
      id: cell.id,
      config: cell.config,
      env: cell.env,
      screens: cell.screens.map(({ env: _env, ...screen }) => screen),
    })),
    findings: groups.map(group => group.finding),
  });
  const reportPath = path.join(out, 'report.md');
  fs.writeFileSync(reportPath, renderReport(meta, outcome.cells, groups));
  return reportPath;
}
