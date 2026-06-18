import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { OutboundEmailParams } from '@/lib/email-delivery-policy';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function findWorkspaceRoot(startDirectory: string): Promise<string> {
  let directory = path.resolve(startDirectory);

  while (true) {
    try {
      await access(path.join(directory, 'pnpm-workspace.yaml'));
      return directory;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) return path.resolve(startDirectory);
      directory = parent;
    }
  }
}

function developmentBanner(params: OutboundEmailParams): string {
  const replyTo = params.replyTo ?? 'hi@kilocode.ai';
  return `<section style="margin:0;padding:16px;border-bottom:2px solid #d97706;background:#fffbeb;color:#451a03;font:14px/1.5 monospace"><strong>Local email capture</strong><br>Intended recipient: ${escapeHtml(params.to)}<br>Subject: ${escapeHtml(params.subject)}<br>Reply-To: ${escapeHtml(replyTo)}</section>`;
}

function addDevelopmentBanner(html: string, banner: string): string {
  const bodyTag = /<body\b[^>]*>/i.exec(html);
  if (!bodyTag || bodyTag.index === undefined) return `${banner}${html}`;
  const insertionPoint = bodyTag.index + bodyTag[0].length;
  return `${html.slice(0, insertionPoint)}${banner}${html.slice(insertionPoint)}`;
}

export async function writeEmailToLocalOutbox(
  params: OutboundEmailParams,
  outboxDirectory?: string
): Promise<string> {
  const workspaceRoot = await findWorkspaceRoot(process.cwd());
  const directory = outboxDirectory ?? path.join(workspaceRoot, 'dev', 'logs', 'emails');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(directory, `${timestamp}-${randomUUID()}.html`);
  const html = addDevelopmentBanner(params.html, developmentBanner(params));
  await writeFile(filePath, html, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return filePath;
}
