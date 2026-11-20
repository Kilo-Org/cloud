import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDeciderCheck } from '../grading';
import { CONTINUATION_CASES } from './continuation-cases';
import type { DeciderCase } from './decider-cases';
import { DECIDER_CASES, FRONTIER_CASES } from './decider-cases';

// The CLI bash tool (kilo v7.8.27, packages/opencode/src/tool/shell.ts) returns the
// merged output unmodified unless it exceeds 2000 lines or 50 KiB.
const TOOL_MAX_LINES = 2000;
const TOOL_MAX_BYTES = 50 * 1024;

/**
 * Reference solutions for the steps each session still has to run. `solve` ends with a command
 * printing the final answer; `baseline` skips or shortcuts the remaining work the way a model
 * that stops early or guesses would, and must not reach the pinned answer.
 */
const REFERENCES: Record<string, { solve: string[]; baseline: string[] }> = {};

const ROLLUP_ANSWER = String.raw`node - <<'EOF'
const fs = require('fs');
const crypto = require('crypto');
const buf = fs.readFileSync('out/rollup.json');
const { customers } = JSON.parse(buf);
console.log(JSON.stringify({
  customers: customers.length,
  paidInvoices: customers.reduce((s, c) => s + c.invoices, 0),
  eurMinor: customers.reduce((s, c) => s + c.eurMinor, 0),
  sha256: crypto.createHash('sha256').update(buf).digest('hex'),
}));
EOF`;

REFERENCES['cont-agent-tool-invoice-rollup'] = {
  solve: [
    String.raw`cat > scripts/rollup.js <<'EOF'
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');
const { rates } = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'rates.json'), 'utf8'));
const text = fs.readFileSync(path.join(ROOT, 'data', 'invoices.csv'), 'utf8');
const byCustomer = new Map();
for (const line of text.trim().split('\n').slice(1)) {
  const [, customer, currency, amount, status] = line.split(',');
  if (status !== 'paid') continue;
  const eur = (BigInt(amount) * BigInt(rates[currency]) + 500000n) / 1000000n;
  const entry = byCustomer.get(customer) ?? { customer, invoices: 0, eurMinor: 0 };
  entry.invoices += 1;
  entry.eurMinor += Number(eur);
  byCustomer.set(customer, entry);
}
const customers = [...byCustomer.values()].sort((a, b) =>
  a.customer < b.customer ? -1 : a.customer > b.customer ? 1 : 0
);
if (dryRun) {
  for (const c of customers) console.log(c.customer, c.invoices, c.eurMinor);
} else {
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'out', 'rollup.json'), JSON.stringify({ customers }, null, 2) + '\n');
}
EOF`,
    'node scripts/rollup.js',
    ROLLUP_ANSWER,
  ],
  baseline: ['node scripts/rollup.js', ROLLUP_ANSWER],
};

const LATENCY_SCRIPT = String.raw`cat > latency.js <<'EOF'
const fs = require('fs');
const groups = new Map();
for (const file of fs.readdirSync('logs').filter(f => f.endsWith('.log')).sort()) {
  for (const line of fs.readFileSync('logs/' + file, 'utf8').split('\n')) {
    if (line === '') continue;
    const m = /"(\S+) (\S+) HTTP\/1\.1" (\d{3}) \d+ (\d+)\.(\d{3}) /.exec(line);
    if (process.env.KEEP_5XX !== '1' && Number(m[3]) >= 500) continue;
    const route = m[1] + ' ' + m[2].split('?')[0].split('/').map(s => (/^\d+$/.test(s) ? ':id' : s)).join('/');
    if (!groups.has(route)) groups.set(route, []);
    groups.get(route).push(Number(m[4]) * 1000 + Number(m[5]));
  }
}
const rank = (xs, p) => xs[Math.ceil((p * xs.length) / 100) - 1];
const rows = ['route\tcount\tp50_ms\tp95_ms'];
for (const route of [...groups.keys()].sort()) {
  const xs = groups.get(route).sort((a, b) => a - b);
  rows.push([route, xs.length, rank(xs, 50), rank(xs, 95)].join('\t'));
}
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/latency.tsv', rows.join('\n') + '\n');
EOF`;

const LATENCY_ANSWER = String.raw`node - <<'EOF'
const fs = require('fs');
const crypto = require('crypto');
const buf = fs.readFileSync('out/latency.tsv');
const rows = buf.toString('utf8').trimEnd().split('\n').slice(1).map(l => l.split('\t'));
let slowest = rows[0];
for (const r of rows) if (Number(r[3]) > Number(slowest[3])) slowest = r;
let excluded = 0;
for (const f of fs.readdirSync('logs').filter(f => f.endsWith('.log'))) {
  for (const line of fs.readFileSync('logs/' + f, 'utf8').split('\n')) {
    const m = /HTTP\/1\.1" (\d{3}) /.exec(line);
    if (m && Number(m[1]) >= 500) excluded++;
  }
}
console.log(JSON.stringify({
  routes: rows.length,
  excluded5xx: excluded,
  slowestP95: slowest[0],
  sha256: crypto.createHash('sha256').update(buf).digest('hex'),
}));
EOF`;

REFERENCES['cont-agent-tool-access-latency'] = {
  solve: [LATENCY_SCRIPT, 'node latency.js && wc -l < out/latency.tsv', LATENCY_ANSWER],
  baseline: [LATENCY_SCRIPT, 'KEEP_5XX=1 node latency.js', LATENCY_ANSWER],
};

const I18N_SYNC = String.raw`cat > sync.js <<'EOF'
const fs = require('fs');
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const en = JSON.parse(fs.readFileSync('locales/en.json', 'utf8'));
const added = {};
let removed = 0;
for (const locale of ['de', 'es', 'fr']) {
  const file = 'locales/' + locale + '.json';
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = {};
  added[locale] = 0;
  for (const key of Object.keys(en)) {
    if (has(data, key)) out[key] = data[key];
    else {
      out[key] = '[TODO] ' + en[key];
      added[locale]++;
    }
  }
  removed += Object.keys(data).filter(k => !has(en, k)).length;
  if (process.env.DRY !== '1') fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
}
fs.writeFileSync('counts.json', JSON.stringify({ added, removed }));
EOF
node sync.js`;

const I18N_ANSWER = String.raw`node - <<'EOF'
const fs = require('fs');
const crypto = require('crypto');
const counts = JSON.parse(fs.readFileSync('counts.json', 'utf8'));
const hash = crypto.createHash('sha256');
for (const l of ['de', 'es', 'fr']) hash.update(fs.readFileSync('locales/' + l + '.json'));
console.log(JSON.stringify({ added: counts.added, removed: counts.removed, sha256: hash.digest('hex') }));
EOF`;

REFERENCES['cont-agent-tool-i18n-sync'] = {
  solve: [I18N_SYNC, 'node scripts/check-locales.js', I18N_ANSWER],
  baseline: [`export DRY=1\n${I18N_SYNC}`, I18N_ANSWER],
};

const ENV_ROLLOUT = String.raw`raised=0
added=0
for f in $(find deploy -name prod.env | LC_ALL=C sort); do
  grep -q '^DB_POOL_SIZE=' "$f" || continue
  v=$(sed -n 's/^DB_POOL_SIZE=//p' "$f")
  if [ "$v" -lt 20 ]; then
    [ "$DRY" = 1 ] || sed -i 's/^DB_POOL_SIZE=.*/DB_POOL_SIZE=20/' "$f"
    raised=$((raised + 1))
  fi
  if ! grep -q '^DB_POOL_TIMEOUT_MS=' "$f"; then
    [ "$DRY" = 1 ] || sed -i '/^DB_POOL_SIZE=/a DB_POOL_TIMEOUT_MS=5000' "$f"
    added=$((added + 1))
  fi
done
printf '{"raised":%d,"timeoutAdded":%d' "$raised" "$added" > counts.txt`;

const ENV_MANIFEST = String.raw`cd deploy && find . -name '*.env' -type f | LC_ALL=C sort | xargs sha256sum > MANIFEST.sha256`;
const ENV_ANSWER = String.raw`printf '%s,"manifestSha256":"%s"}\n' "$(cat counts.txt)" "$(sha256sum deploy/MANIFEST.sha256 | cut -d' ' -f1)"`;

REFERENCES['cont-agent-term-env-rollout'] = {
  solve: [
    ENV_ROLLOUT,
    "grep -h 'DB_POOL' deploy/*/prod.env | LC_ALL=C sort | uniq -c",
    ENV_MANIFEST,
    ENV_ANSWER,
  ],
  baseline: [`DRY=1\n${ENV_ROLLOUT}`, ENV_MANIFEST, ENV_ANSWER],
};

const LOG_ANSWER = String.raw`node - <<'EOF'
const fs = require('fs');
const crypto = require('crypto');
const entries = {};
for (const level of ['ERROR', 'WARN', 'INFO', 'DEBUG']) {
  entries[level] = fs.readFileSync('out/' + level + '.log', 'utf8').split('\n').filter(l => /^[0-9]/.test(l)).length;
}
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
console.log(JSON.stringify({
  entries,
  errorLines: fs.readFileSync('out/ERROR.log', 'utf8').split('\n').length - 1,
  errorSha256: sha('out/ERROR.log'),
  warnSha256: sha('out/WARN.log'),
}));
EOF`;

REFERENCES['cont-agent-term-log-split'] = {
  solve: [
    String.raw`mkdir -p out && for l in ERROR WARN INFO DEBUG; do : > out/$l.log; done && awk '/^[0-9]/ { lvl = $2 } { print > ("out/" lvl ".log") }' var/log/app.log`,
    'cat out/ERROR.log out/WARN.log out/INFO.log out/DEBUG.log | wc -l; wc -l < var/log/app.log',
    LOG_ANSWER,
  ],
  baseline: [
    String.raw`mkdir -p out && for l in ERROR WARN INFO DEBUG; do grep " $l " var/log/app.log > out/$l.log; done; true`,
    LOG_ANSWER,
  ],
};

const MIGRATION_MOVES = String.raw`cd db/migrations
mv 0113_add_invoice_notes.sql 0117_add_invoice_notes.sql
mv 0114_backfill_invoice_notes.sql 0118_backfill_invoice_notes.sql
mv 0115_index_invoice_notes.sql 0119_index_invoice_notes.sql
mv 0116_invoice_notes_audit_trigger.sql 0120_invoice_notes_audit_trigger.sql`;
const MIGRATION_SED = String.raw`sed -i -e 's/0113_add_invoice_notes/0117_add_invoice_notes/g' -e 's/0114_backfill_invoice_notes/0118_backfill_invoice_notes/g' -e 's/0115_index_invoice_notes/0119_index_invoice_notes/g' -e 's/0116_invoice_notes_audit_trigger/0120_invoice_notes_audit_trigger/g' 0117_add_invoice_notes.sql 0118_backfill_invoice_notes.sql 0119_index_invoice_notes.sql 0120_invoice_notes_audit_trigger.sql`;
const MIGRATION_JOURNAL = String.raw`node - <<'EOF'
const fs = require('fs');
const file = 'db/migrations/journal.json';
const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
const renames = {
  '0113_add_invoice_notes.sql': '0117_add_invoice_notes.sql',
  '0114_backfill_invoice_notes.sql': '0118_backfill_invoice_notes.sql',
  '0115_index_invoice_notes.sql': '0119_index_invoice_notes.sql',
  '0116_invoice_notes_audit_trigger.sql': '0120_invoice_notes_audit_trigger.sql',
};
for (const m of journal.migrations) {
  if (m.branch === 'feature/invoice-notes') m.file = renames[m.file];
}
journal.migrations.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
fs.writeFileSync(file, JSON.stringify(journal, null, 2) + '\n');
EOF`;
const MIGRATION_ANSWER = String.raw`node scripts/verify-migrations.js | sed -E 's/^OK ([0-9]+) migrations, last ([^,]+), sha256 ([0-9a-f]+)$/{"migrations":\1,"last":"\2","sha256":"\3"}/'`;

REFERENCES['cont-agent-term-migration-renumber'] = {
  solve: [`${MIGRATION_MOVES}\n${MIGRATION_SED}`, MIGRATION_JOURNAL, MIGRATION_ANSWER],
  baseline: [MIGRATION_MOVES, MIGRATION_JOURNAL, MIGRATION_ANSWER],
};

const PRICING_ANSWER = String.raw`t=$(node test/run.js)
p=$(printf '%s\n' "$t" | sed -n 's/^# pass //p')
f=$(printf '%s\n' "$t" | sed -n 's/^# fail //p')
n=$(($(wc -l < out/quotes.csv) - 1))
s=$(sha256sum out/quotes.csv | cut -d' ' -f1)
printf '{"passed":%s,"failed":%s,"orders":%s,"sha256":"%s"}\n' "$p" "$f" "$n" "$s"`;

REFERENCES['cont-agent-multi-pricing-fix'] = {
  solve: [
    String.raw`cat > src/pricing.js <<'EOF'
'use strict';

/** Rounds numerator / denominator (integers, numerator >= 0) to an integer, ties to even. */
function roundCents(numerator, denominator = 1) {
  const q = Math.floor(numerator / denominator);
  const r = numerator - q * denominator;
  return 2 * r > denominator || (2 * r === denominator && q % 2 !== 0) ? q + 1 : q;
}

function priceOrder(order) {
  const subtotal = order.lines.reduce((sum, line) => sum + line.qty * line.unitCents, 0);
  const discount = roundCents(subtotal * order.discountBps, 10000);
  const tax = roundCents((subtotal - discount) * order.taxBps, 10000);
  return { subtotal, discount, tax, total: subtotal - discount + tax };
}

module.exports = { priceOrder, roundCents };
EOF`,
    'node test/run.js | tail -n 3',
    'node scripts/build-quotes.js',
    PRICING_ANSWER,
  ],
  baseline: ['node scripts/build-quotes.js', PRICING_ANSWER],
};

const userMigrate = (familySplit: 'indexOf' | 'lastIndexOf') =>
  String.raw`cat > scripts/migrate.js <<'EOF'
const fs = require('fs');
const out = fs
  .readFileSync('fixtures/users-v1.jsonl', 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => {
    const u = JSON.parse(line);
    const name = u.name.trim();
    const space = name.SPLIT(' ');
    return JSON.stringify({
      id: 'usr_' + String(u.id).padStart(6, '0'),
      givenName: space < 0 ? name : name.slice(0, space),
      familyName: space < 0 ? '' : name.slice(space + 1),
      email: u.email.trim().toLowerCase(),
      createdAt: u.created.replace(' ', 'T') + 'Z',
      roles: [...new Set(u.roles.split(',').map(r => r.trim()).filter(Boolean))].sort(),
      active: u.active === 'yes',
      timezone: u.prefs.tz,
      newsletter: u.prefs.newsletter === 1,
    });
  });
fs.writeFileSync('fixtures/users-v2.jsonl', out.join('\n') + '\n');
EOF`.replace('SPLIT', familySplit);

const USER_ANSWER = String.raw`node - <<'EOF'
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const buf = fs.readFileSync('fixtures/users-v2.jsonl');
const records = buf.toString('utf8').trimEnd().split('\n').map(l => JSON.parse(l));
const report = execFileSync('node', ['scripts/validate-v2.js', 'fixtures/users-v2.jsonl'], { encoding: 'utf8' });
console.log(JSON.stringify({
  records: records.length,
  valid: Number(/valid (\d+)\//.exec(report)[1]),
  activeAdmins: records.filter(r => r.active && r.roles.includes('admin')).length,
  sha256: crypto.createHash('sha256').update(buf).digest('hex'),
}));
EOF`;

REFERENCES['cont-agent-multi-user-migration'] = {
  solve: [
    userMigrate('indexOf'),
    'node scripts/migrate.js && node scripts/validate-v2.js fixtures/users-v2.jsonl',
    USER_ANSWER,
  ],
  baseline: [userMigrate('lastIndexOf'), 'node scripts/migrate.js', USER_ANSWER],
};

const ETL_ANSWER = String.raw`line=$(node etl/check.js)
s=$(sha256sum out/daily.csv | cut -d' ' -f1)
printf '%s\n' "$line" | sed -E 's/^check: OK rows=([0-9]+) events=([0-9]+) amount_minor=(-?[0-9]+)$/{"rows":\1,"events":\2,"amountMinor":\3,"sha256":"'"$s"'"}/'`;

REFERENCES['cont-agent-multi-etl-dedupe'] = {
  solve: [
    String.raw`node - <<'EOF'
const fs = require('fs');
const file = 'etl/transform.js';
const source = fs.readFileSync(file, 'utf8');
const start = source.indexOf('function transform(events) {');
const end = source.indexOf('module.exports');
const fixed = [
  'function transform(events) {',
  '  const best = new Map();',
  '  for (const e of events) {',
  '    const prev = best.get(e.event_id);',
  '    if (!prev || e.seq >= prev.seq) best.set(e.event_id, e); // highest seq wins, later delivery on ties',
  '  }',
  '  return [...best.values()].map(e => ({',
  '    date: new Date(e.ts).toISOString().slice(0, 10),',
  '    account: e.account,',
  '    type: e.type,',
  '    amount_minor: e.amount_minor,',
  '  }));',
  '}',
  '',
  '',
].join('\n');
fs.writeFileSync(file, source.slice(0, start) + fixed + source.slice(end));
EOF`,
    'bash etl/run.sh && node etl/check.js',
    ETL_ANSWER,
  ],
  baseline: ['bash etl/run.sh', ETL_ANSWER],
};

function materialize(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'continuation-case-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function snapshot(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, snapshot(dir, path));
    else out[path] = readFileSync(join(dir, path), 'utf8');
  }
  return out;
}

function runBash(cwd: string, command: string) {
  const result = spawnSync('bash', ['-c', command], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function firstDifference(actual: string, expected: string): string | null {
  if (actual === expected) return null;
  let i = 0;
  while (i < actual.length && i < expected.length && actual[i] === expected[i]) i++;
  return `differs at ${i}: actual ${JSON.stringify(actual.slice(Math.max(0, i - 80), i + 80))} expected ${JSON.stringify(expected.slice(Math.max(0, i - 80), i + 80))}`;
}

function transcriptChars(benchCase: DeciderCase): number {
  let total = benchCase.userPrompt.length;
  for (const step of benchCase.continuation?.steps ?? []) {
    total += step.text?.length ?? 0;
    for (const call of step.calls) total += call.command.length + call.output.length;
  }
  return total;
}

function withWorkspace<T>(benchCase: DeciderCase, fn: (dir: string) => T): T {
  const dir = materialize(benchCase.continuation!.files);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('CONTINUATION_CASES', () => {
  it('has 9 agentic continuation cases, 3 per subtask, with unique new ids', () => {
    expect(CONTINUATION_CASES).toHaveLength(9);
    const ids = CONTINUATION_CASES.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const existing = new Set([...DECIDER_CASES, ...FRONTIER_CASES].map(c => c.id));
    for (const id of ids) {
      expect(id).toMatch(/^cont-agent-(tool|term|multi)-[a-z0-9-]+$/);
      expect(existing.has(id)).toBe(false);
    }
    for (const subtask of ['tool_usage', 'terminal_operations', 'multi_step_execution']) {
      expect(CONTINUATION_CASES.filter(c => c.subtaskType === subtask)).toHaveLength(3);
    }
    for (const c of CONTINUATION_CASES) {
      expect(c.taskType).toBe('agentic_execution');
      expect(c.requiredToolCalls).toBe(1);
      expect(c.check.kind).toBe('json_equal');
      expect(JSON.stringify(c.check)).not.toContain('PENDING');
      expect(c.continuation?.message).toBe('Continue.');
      expect(Object.keys(REFERENCES)).toContain(c.id);
    }
  });

  it('keeps every transcript between 10k and 45k tokens (40k-180k chars)', () => {
    for (const c of CONTINUATION_CASES) {
      const chars = transcriptChars(c);
      expect(chars, c.id).toBeGreaterThanOrEqual(40_000);
      expect(chars, c.id).toBeLessThanOrEqual(180_000);
    }
  });

  it('seeds at least 3 bash calls across at least 2 steps, each below the tool truncation limits', () => {
    for (const c of CONTINUATION_CASES) {
      const steps = c.continuation!.steps;
      expect(steps.length, c.id).toBeGreaterThanOrEqual(2);
      const calls = steps.flatMap(step => step.calls);
      expect(calls.length, c.id).toBeGreaterThanOrEqual(3);
      for (const call of calls) {
        expect(call.output.length, `${c.id}: ${call.command}`).toBeGreaterThan(0);
        expect(call.output.split('\n').length, `${c.id}: ${call.command}`).toBeLessThanOrEqual(
          TOOL_MAX_LINES
        );
        expect(
          Buffer.byteLength(call.output, 'utf8'),
          `${c.id}: ${call.command}`
        ).toBeLessThanOrEqual(TOOL_MAX_BYTES);
      }
    }
  });

  it('never shows a pinned hash in the transcript', () => {
    for (const c of CONTINUATION_CASES) {
      const transcript = [
        c.userPrompt,
        ...c.continuation!.steps.flatMap(step => [
          step.text ?? '',
          ...step.calls.map(call => call.output),
        ]),
      ].join('\n');
      const hashes = JSON.stringify(c.check).match(/[0-9a-f]{64}/g) ?? [];
      expect(hashes.length, c.id).toBeGreaterThan(0);
      for (const hash of hashes) expect(transcript.includes(hash), c.id).toBe(false);
    }
  });

  describe.each(CONTINUATION_CASES.map(c => [c.id, c] as const))('%s', (_id, benchCase) => {
    const check = benchCase.check;
    if (check.kind !== 'json_equal')
      throw new Error(`${benchCase.id}: expected a json_equal check`);
    const reference = REFERENCES[benchCase.id];

    it('reproduces every seeded output byte for byte without changing the workspace', () => {
      withWorkspace(benchCase, dir => {
        for (const call of benchCase.continuation!.steps.flatMap(step => step.calls)) {
          const result = runBash(dir, call.command);
          expect(result.stderr, call.command).toBe('');
          expect(firstDifference(result.stdout, call.output), call.command).toBeNull();
        }
        expect(snapshot(dir)).toEqual(benchCase.continuation!.files);
      });
    }, 120_000);

    it('reaches the pinned answer only by running the remaining steps', () => {
      expect(reference.solve.length).toBeGreaterThanOrEqual(2);
      withWorkspace(benchCase, dir => {
        let last = '';
        for (const command of reference.solve) {
          const result = runBash(dir, command);
          expect(result.status, `${command}\n${result.stdout}${result.stderr}`).toBe(0);
          expect(result.stderr, command).toBe('');
          last = result.stdout;
        }
        const answer = last.trim().split('\n').at(-1) ?? '';
        expect(answer).toBe(JSON.stringify(check.value));
        expect(runDeciderCheck(check, last)).toBe(true);
      });
      withWorkspace(benchCase, dir => {
        let last = '';
        for (const command of reference.baseline) {
          const result = runBash(dir, command);
          last = result.stdout + result.stderr;
        }
        expect(runDeciderCheck(check, last), last).toBe(false);
      });
    }, 120_000);
  });
});
