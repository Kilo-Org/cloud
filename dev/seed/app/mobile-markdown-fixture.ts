import { execFileSync } from 'node:child_process';

import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { and, eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';
import {
  buildAssistantMessageItem,
  buildFilePartItem,
  buildToolPartItem,
  buildSessionItem,
  buildUserMessageItem,
  parseSessionIngestServiceStatus,
  type SessionIngestItem,
} from '../lib/mobile-sheet-fixtures';

export const usage = '<email>';

// 30 chars: ses_ + 26.
const SESSION_ID = 'ses_00000000000MarkdownLibs001';
const SESSION_TITLE = 'Markdown libraries fixture';
const USER_ID = 'msgMdLibsUser000001';
const ASSISTANT_ID = 'msgMdLibsAsst000001';
const PART_RICH = 'prtMdLibsRich000001';
const PART_BIG = 'prtMdLibsBig0000001';
const PART_MERMAID = 'prtMdLibsMermaid001';
const PART_HTML = 'prtMdLibsHtml000001';
const PART_READ = 'prtMdLibsRead000001';
const PART_FILE = 'prtMdLibsFile000001';
const EXPECTED = [PART_RICH, PART_BIG, PART_MERMAID, PART_HTML, PART_READ, PART_FILE];
const MD_DOC = [
  '# Notes file',
  '',
  '- item **one**',
  '- item `two`',
  '',
  '| k | v |',
  '| - | - |',
  '| a | 1 |',
  '',
  '```ts',
  'const ok = true;',
  '```',
].join('\n');
const T0 = 1_700_700_000_000;

const FENCE = '```';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-markdown-fixture ${usage}`);
  console.log('');
  console.log('Seeds one agent session whose assistant message covers the markdown,');
  console.log('Mermaid, and HTML-in-markdown renderers, through the local');
  console.log('cloudflare-session-ingest worker. Resets only its own session.');
  console.log('');
  console.log('Example:');
  console.log('  pnpm dev:seed app:mobile-markdown-fixture ada@example.com');
}

const RICH = [
  '# Heading one',
  '## Heading two',
  'Plain paragraph with **bold**, *italic*, ~~struck~~, `inline code`, and a [link](https://kilo.ai/docs).',
  '',
  '- First bullet',
  '- Second bullet with `code`',
  '  - Nested bullet',
  '1. Ordered one',
  '2. Ordered two',
  '',
  '> A blockquote line that wraps across more than one line on a phone screen to check the rule.',
  '',
  '| Column A | Column B | Column C |',
  '| :-- | :-: | --: |',
  '| left | center | 1 |',
  '| **bold** | `code` | 22 |',
  '',
  'Wide table (8 columns):',
  '',
  '| Service | Region | Status | p50 | p99 | Errors | Owner | Last deploy |',
  '| --- | --- | --- | --: | --: | --: | --- | --- |',
  '| session-ingest | fra1 | healthy | 12 ms | 88 ms | 0.01% | platform | 2026-10-05 14:02 |',
  '| cloud-agent-next | sfo1 | degraded | 140 ms | 2.4 s | 1.20% | agents | 2026-10-06 09:41 |',
  '| kilo-chat | fra1 | healthy | 9 ms | 41 ms | 0.00% | chat | 2026-10-04 18:30 |',
  '| event-service | fra1 | healthy | 6 ms | 30 ms | 0.02% | platform | 2026-10-03 11:15 |',
  '',
  'Long-cell table:',
  '',
  '| File | Change |',
  '| --- | --- |',
  '| `apps/mobile/src/components/agents/markdown-enriched.tsx` | Overrides the library light-theme defaults for table rows, quotes and bullets so dark mode reads correctly, and disables the block context menu. |',
  '| `apps/mobile/src/lib/glanceable/tray-refresh.ts` | Builds the publisher before the tray read so a sign-out during the read wins the surface. |',
  '',
  'Three diagrams in one message:',
  '',
  `${FENCE}mermaid`,
  'graph LR',
  '  A[One] --> B[Two]',
  FENCE,
  '',
  `${FENCE}mermaid`,
  'sequenceDiagram',
  '  App->>API: list sessions',
  '  API-->>App: rows',
  FENCE,
  '',
  `${FENCE}mermaid`,
  'pie title Status',
  '  "Working" : 3',
  '  "Idle" : 5',
  FENCE,
  '',
  `${FENCE}typescript`,
  'export function greet(name: string): string {',
  '  // A comment',
  '  return `Hello, ${name}!`;',
  '}',
  FENCE,
  '',
  `${FENCE}json`,
  '{ "ok": true, "count": 3 }',
  FENCE,
  '',
  '<details><summary>HTML block</summary>Inner <b>html</b> text.</details>',
  '',
  'Last paragraph after the HTML block.',
  '',
  '![GitHub avatar](https://avatars.githubusercontent.com/u/9919?s=96)',
].join('\n');

const BIG = [
  'A large fence follows (1,500 lines):',
  '',
  `${FENCE}typescript`,
  ...Array.from(
    { length: 1_500 },
    (_, i) => `const value${i} = compute(${i}, "row ${i}") + ${i * 3}; // line ${i}`
  ),
  FENCE,
].join('\n');

const MERMAID = [
  'A diagram:',
  '',
  `${FENCE}mermaid`,
  'flowchart LR',
  '  A[Prompt] --> B{Agent}',
  '  B -->|tool| C[Shell]',
  '  B -->|answer| D[User]',
  FENCE,
  '',
  'Text after the diagram.',
].join('\n');

// HTML inside markdown: the first paragraph, the image, and the table convert
// to markdown; details, kbd, sub/sup, and the unknown tag stay HTML; the fence
// keeps its literal tag.
const HTML = [
  'HTML that converts: <b>bold</b>, <i>italic</i>, <s>struck</s>, <code>inline code</code>, and <a href="https://kilo.ai/docs">a link</a>.',
  '',
  'An untrusted image: <img src="https://picsum.photos/seed/kilo/240/120" alt="untrusted image">',
  '',
  '<table>',
  '  <thead><tr><th>Key</th><th>Meaning</th></tr></thead>',
  '  <tbody>',
  '    <tr><td><b>Ctrl</b></td><td>Control</td></tr>',
  '    <tr><td><code>Esc</code></td><td>Escape</td></tr>',
  '  </tbody>',
  '</table>',
  '',
  '<details>',
  '<summary>Show the <b>details</b></summary>',
  '',
  'The body is **markdown**, with a list:',
  '',
  '- one',
  '- two',
  '',
  '</details>',
  '',
  'Copy with <kbd>Ctrl</kbd>+<kbd>C</kbd>.',
  '',
  'Water is H<sub>2</sub>O and the area is x<sup>2</sup>.',
  '',
  'A footnote mark with no script form stays HTML: see note<sup>[1]</sup>.',
  '',
  'An unknown tag: <custom-note>stays HTML</custom-note>.',
  '',
  'A literal tag in a code fence:',
  '',
  `${FENCE}html`,
  '<b>not bold</b>',
  FENCE,
].join('\n');

function textPart(id: string, text: string): SessionIngestItem {
  return {
    type: 'part',
    data: { id, sessionID: SESSION_ID, messageID: ASSISTANT_ID, type: 'text', text },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function waitForParts(baseUrl: string, token: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await fetch(`${baseUrl}/api/session/${SESSION_ID}/messages?limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`messages read failed (${response.status})`);
    const payload: unknown = await response.json();
    const seen = new Set<string>();
    if (isRecord(payload) && isRecord(payload.history) && Array.isArray(payload.history.messages)) {
      for (const message of payload.history.messages) {
        if (!isRecord(message) || !Array.isArray(message.parts)) continue;
        for (const part of message.parts) {
          if (isRecord(part) && typeof part.id === 'string') seen.add(part.id);
        }
      }
    }
    if (EXPECTED.every(id => seen.has(id))) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for markdown parts');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const email = args[0]?.trim();
  if (!email) {
    printUsage();
    throw new Error('email is required');
  }
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('NEXTAUTH_SECRET is not set for this worktree.');
  }

  const db = getSeedDb();
  const [user] = await db
    .select({
      id: kilocode_users.id,
      apiTokenPepper: kilocode_users.api_token_pepper,
      isAdmin: kilocode_users.is_admin,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.google_user_email, email))
    .limit(1);
  if (!user) {
    throw new Error(`No user for ${email}.`);
  }

  const status = parseSessionIngestServiceStatus(
    execFileSync('pnpm', ['-s', 'dev:status', '--json'], { encoding: 'utf8' })
  );
  if (status.status !== 'up') {
    throw new Error(`cloudflare-session-ingest is ${status.status}.`);
  }
  const baseUrl = `http://localhost:${status.port}`;

  await db
    .delete(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.kilo_user_id, user.id), eq(cli_sessions_v2.session_id, SESSION_ID))
    );
  await db.insert(cli_sessions_v2).values({
    session_id: SESSION_ID,
    kilo_user_id: user.id,
    title: SESSION_TITLE,
    created_on_platform: 'cli',
  });

  const { token } = await signKiloToken({
    userId: user.id,
    pepper: user.apiTokenPepper,
    secret,
    expiresInSeconds: 3600,
    env: process.env.NODE_ENV ?? 'development',
    extra: user.isAdmin ? { isAdmin: true } : undefined,
  });

  const items: SessionIngestItem[] = [
    buildSessionItem({
      sessionId: SESSION_ID,
      slug: 'markdown-libs-fixture',
      title: SESSION_TITLE,
    }),
    buildUserMessageItem({ messageId: USER_ID, sessionId: SESSION_ID, createdAt: T0 }),
    buildAssistantMessageItem({
      messageId: ASSISTANT_ID,
      sessionId: SESSION_ID,
      parentId: USER_ID,
      createdAt: T0 + 1_000,
      completedAt: T0 + 2_000,
      cost: 0.01,
      tokens: { total: 100, input: 80, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    textPart(PART_RICH, RICH),
    textPart(PART_BIG, BIG),
    textPart(PART_MERMAID, MERMAID),
    textPart(PART_HTML, HTML),
    buildToolPartItem({
      partId: PART_READ,
      sessionId: SESSION_ID,
      messageId: ASSISTANT_ID,
      callId: 'callMdLibsRead00001',
      tool: 'read',
      input: { filePath: '/workspace/NOTES.md' },
      output: MD_DOC,
      title: 'Read NOTES.md',
      metadata: {
        display: {
          path: '/workspace/NOTES.md',
          text: MD_DOC,
          lineStart: 1,
          lineEnd: 12,
          totalLines: 12,
          truncated: false,
        },
      },
      start: T0 + 1_100,
      end: T0 + 1_200,
    }),
    buildFilePartItem({
      partId: PART_FILE,
      sessionId: SESSION_ID,
      messageId: ASSISTANT_ID,
      mime: 'text/markdown',
      filename: 'notes.md',
      url: `data:text/markdown;base64,${Buffer.from(MD_DOC).toString('base64')}`,
    }),
  ];
  const response = await fetch(`${baseUrl}/api/session/${SESSION_ID}/ingest?v=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: items }),
  });
  if (!response.ok) {
    throw new Error(`ingest failed (${response.status}): ${await response.text()}`);
  }
  await waitForParts(baseUrl, token);
  console.log(
    'This fixture represents: one finished agent turn whose text parts exercise markdown, Mermaid, and HTML in markdown, plus a Markdown read tool and file part.'
  );
  console.log('Suggested next step: open the deep link on a signed-in dev build.');
  return { userId: user.id, sessionId: SESSION_ID, deepLink: `kiloapp://agent-chat/${SESSION_ID}` };
}
