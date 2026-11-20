import type { ContinuationToolCall, DeciderCase } from './decider-cases';

// Agentic sessions resumed mid-task. Each case is the original user task, a
// workspace (`files`), and the read-only steps an earlier assistant turn already
// ran (inspections, dry runs, failing tests), with exactly what the CLI bash tool
// returned for them: merged stdout/stderr, unmodified, every output well below
// the tool's 2000-line / 50 KiB truncation limits. The remaining steps (edit,
// run, verify, checksum) change the workspace, and every pinned value depends on
// their result, mostly a SHA-256 of a file they produce. A model that only
// narrates its next step, or answers from the transcript, fails the check.
//
// Content is generated deterministically (seeded PRNG, fixed templates) and every
// seeded output is derived from the generated files the same way the command
// derives it. The test materializes each workspace, reruns every seeded command
// under bash, and runs a reference solution against the pinned answer.

const AGENT_SYS =
  'You are a precise coding agent with file and terminal tools available. Complete the task exactly as specified, then answer with only what is asked, no explanations.';

const RESUME = 'Continue.';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(probability: number): boolean {
    return this.next() < probability;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  weighted<T extends { weight: number }>(items: readonly T[]): T {
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    let roll = this.next() * total;
    for (const item of items) {
      roll -= item.weight;
      if (roll < 0) return item;
    }
    return items[items.length - 1];
  }
  hex(length: number): string {
    let out = '';
    while (out.length < length) out += this.int(0, 15).toString(16);
    return out;
  }
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

function bash(command: string, description: string, output: string): ContinuationToolCall {
  return { tool: 'bash', command, description, output };
}

const pad = (value: number, width: number) => String(value).padStart(width, '0');

function linesOf(text: string): string[] {
  if (!text.endsWith('\n')) throw new Error('generated file must end with a newline');
  return text.slice(0, -1).split('\n');
}

const joinLines = (lines: readonly string[]) => lines.map(line => `${line}\n`).join('');
const sedRange = (text: string, from: number, to: number) =>
  joinLines(linesOf(text).slice(from - 1, to));
const tailLines = (text: string, count: number) => joinLines(linesOf(text).slice(-count));
const json2 = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `tail -n +1 a b ...` / `head` with several files: GNU headers separated by a blank line. */
function multiFileTail(paths: readonly string[], files: Record<string, string>): string {
  return paths.map((p, i) => `${i === 0 ? '' : '\n'}==> ${p} <==\n${files[p]}`).join('');
}

// ---------------------------------------------------------------------------
// tool_usage: invoice rollup (about 12k tokens)

const INVOICE_CUSTOMERS = [
  'acme-gmbh',
  'aurora-labs',
  'baltic-freight',
  'blue-harbor',
  'cedar-health',
  'copperleaf',
  'delta-optics',
  'ember-studio',
  'fjord-energy',
  'granite-bank',
  'harbor-point',
  'helix-bio',
  'ion-mobility',
  'juniper-retail',
  'kestrel-air',
  'lumen-media',
  'maple-foods',
  'nimbus-cloud',
  'orbit-logistics',
  'pine-legal',
  'quartz-games',
  'riverstone',
  'summit-edu',
  'tundra-mining',
] as const;

const ROLLUP_JS = joinLines([
  "'use strict';",
  '// Rolls invoices up per customer for the monthly finance export.',
  '// Usage: node scripts/rollup.js [--dry-run]',
  "const fs = require('fs');",
  "const path = require('path');",
  '',
  "const ROOT = path.join(__dirname, '..');",
  "const dryRun = process.argv.includes('--dry-run');",
  '',
  'function readInvoices() {',
  "  const text = fs.readFileSync(path.join(ROOT, 'data', 'invoices.csv'), 'utf8');",
  "  const [header, ...rows] = text.trim().split('\\n');",
  "  const cols = header.split(',');",
  '  return rows.map(line => {',
  "    const values = line.split(',');",
  '    return Object.fromEntries(cols.map((col, i) => [col, values[i]]));',
  '  });',
  '}',
  '',
  'function rollup(invoices) {',
  '  const byCustomer = new Map();',
  '  for (const invoice of invoices) {',
  '    // TODO(finance#412): convert to EUR with data/rates.json before summing.',
  '    const entry = byCustomer.get(invoice.customer) ?? { customer: invoice.customer, invoices: 0, eurMinor: 0 };',
  '    entry.invoices += 1;',
  '    entry.eurMinor += Number(invoice.amount_minor);',
  '    byCustomer.set(invoice.customer, entry);',
  '  }',
  '  return [...byCustomer.values()].sort((a, b) =>',
  '    a.customer < b.customer ? -1 : a.customer > b.customer ? 1 : 0',
  '  );',
  '}',
  '',
  'const customers = rollup(readInvoices());',
  'if (dryRun) {',
  '  let invoices = 0;',
  '  let eurMinor = 0;',
  '  for (const c of customers) {',
  '    invoices += c.invoices;',
  '    eurMinor += c.eurMinor;',
  "    console.log(c.customer.padEnd(18) + ' ' + String(c.invoices).padStart(4) + ' ' + String(c.eurMinor).padStart(12));",
  '  }',
  "  console.log('TOTAL customers=' + customers.length + ' invoices=' + invoices + ' eurMinor=' + eurMinor + ' (dry run, nothing written)');",
  '} else {',
  "  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });",
  "  fs.writeFileSync(path.join(ROOT, 'out', 'rollup.json'), JSON.stringify({ customers }, null, 2) + '\\n');",
  "  console.log('wrote out/rollup.json (' + customers.length + ' customers)');",
  '}',
]);

function invoiceRollupCase(): DeciderCase {
  const rng = new Rng(0x1d0c1);
  const currencies = ['EUR', 'EUR', 'EUR', 'USD', 'USD', 'GBP', 'CHF', 'SEK'] as const;
  const rows = ['invoice_id,customer,currency,amount_minor,status,issued_on'];
  const naive = new Map<string, { invoices: number; total: number }>();
  for (let i = 1; i <= 900; i++) {
    const zenith = i % 300 === 0;
    const customer = zenith ? 'zenith-hotels' : rng.pick(INVOICE_CUSTOMERS);
    const currency = rng.pick(currencies);
    const amount = currency === 'SEK' ? rng.int(20_000, 9_000_000) : rng.int(1_500, 900_000);
    const roll = rng.float();
    const status = zenith
      ? i === 600
        ? 'void'
        : 'open'
      : roll < 0.7
        ? 'paid'
        : roll < 0.85
          ? 'open'
          : roll < 0.93
            ? 'void'
            : 'refunded';
    const issued = `2026-${pad(rng.int(1, 10), 2)}-${pad(rng.int(1, 28), 2)}`;
    rows.push([`INV-2026-${pad(i, 5)}`, customer, currency, amount, status, issued].join(','));
    const entry = naive.get(customer) ?? { invoices: 0, total: 0 };
    entry.invoices += 1;
    entry.total += amount;
    naive.set(customer, entry);
  }
  const invoicesCsv = joinLines(rows);
  const ratesJson = json2({
    base: 'EUR',
    unit: 'ppm',
    comment:
      'EUR per 1 unit of the currency, in parts per million. Amounts are minor units (cents, pence, ore, rappen).',
    rates: { CHF: 1046570, EUR: 1000000, GBP: 1168210, SEK: 87420, USD: 921340 },
  });

  const dryRunLines: string[] = [];
  let naiveInvoices = 0;
  let naiveTotal = 0;
  const sorted = [...naive.entries()].sort(([a], [b]) => byCodeUnit(a, b));
  for (const [name, entry] of sorted) {
    naiveInvoices += entry.invoices;
    naiveTotal += entry.total;
    dryRunLines.push(
      `${name.padEnd(18)} ${String(entry.invoices).padStart(4)} ${String(entry.total).padStart(12)}`
    );
  }
  dryRunLines.push(
    `TOTAL customers=${sorted.length} invoices=${naiveInvoices} eurMinor=${naiveTotal} (dry run, nothing written)`
  );

  const files = {
    'data/invoices.csv': invoicesCsv,
    'data/rates.json': ratesJson,
    'scripts/rollup.js': ROLLUP_JS,
  };

  return {
    id: 'cont-agent-tool-invoice-rollup',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt: [
      'You are in the root of the invoice-tools repository (current directory). Finance needs out/rollup.json regenerated with correct numbers.',
      '',
      'Steps:',
      '1. Read scripts/rollup.js and data/rates.json.',
      "2. Inspect data/invoices.csv (a header line, then one invoice per line; amount_minor is an integer amount in minor units of that row's currency).",
      '3. Run `node scripts/rollup.js --dry-run` to see what the current script computes.',
      "4. Fix scripts/rollup.js: count only invoices whose status is exactly `paid`; convert each paid invoice to EUR minor units on its own as round-half-up(amount_minor * rate / 1000000), where rate is the integer ppm rate of the row's currency in data/rates.json, using exact integer math ((amount_minor * rate + 500000) / 1000000 with integer division, e.g. BigInt); then sum per customer. Customers without paid invoices are omitted.",
      '5. Run `node scripts/rollup.js` (no flags) so it writes out/rollup.json. The file must be exactly JSON.stringify({ customers }, null, 2) followed by one newline, where customers is an array of { customer, invoices, eurMinor } objects (invoices = number of paid invoices, eurMinor = EUR total in minor units as a JSON number) sorted by customer in code-unit order.',
      '6. Compute the SHA-256 of out/rollup.json.',
      '',
      'Final answer: compact JSON with exactly these keys in this order: {"customers":<number of entries in out/rollup.json>,"paidInvoices":<sum of invoices over all entries>,"eurMinor":<sum of eurMinor over all entries>,"sha256":"<lowercase hex SHA-256 of out/rollup.json>"}',
    ].join('\n'),
    requiredToolCalls: 1,
    continuation: {
      files,
      steps: [
        {
          text: "I'll start by reading the rollup script and the exchange rates.",
          calls: [
            bash('cat scripts/rollup.js', 'Show the rollup script', ROLLUP_JS),
            bash('cat data/rates.json', 'Show the EUR conversion rates', ratesJson),
          ],
        },
        {
          text: 'Now the invoice data itself.',
          calls: [
            bash('wc -l < data/invoices.csv', 'Count invoice lines', `${rows.length}\n`),
            bash('cat data/invoices.csv', 'Show all invoices', invoicesCsv),
          ],
        },
        {
          text: 'Let me see what the current script computes before changing it.',
          calls: [
            bash(
              'node scripts/rollup.js --dry-run',
              'Dry-run the current rollup',
              joinLines(dryRunLines)
            ),
          ],
        },
      ],
      message: RESUME,
    },
    check: {
      kind: 'json_equal',
      value: {
        customers: 24,
        paidInvoices: 624,
        eurMinor: 274238869,
        sha256: '7bdbaa8a2df7f5a19e767659906f1f2859171ddc6e4f5cbc7845cdb7cb0cae15',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// tool_usage: per-route latency from access logs (about 25k tokens)

const LATENCY_ROUTES = [
  { method: 'GET', path: '/api/v1/orders/{id}', weight: 18, base: 42 },
  { method: 'GET', path: '/api/v1/orders', weight: 9, base: 95 },
  { method: 'POST', path: '/api/v1/orders', weight: 6, base: 160 },
  { method: 'GET', path: '/api/v1/users/{id}', weight: 12, base: 28 },
  { method: 'GET', path: '/api/v1/users/{id}/sessions', weight: 5, base: 64 },
  { method: 'DELETE', path: '/api/v1/users/{id}/sessions/{id}', weight: 2, base: 51 },
  { method: 'GET', path: '/api/v1/catalog/items/{id}', weight: 16, base: 35 },
  { method: 'GET', path: '/api/v1/catalog/search', weight: 10, base: 120 },
  { method: 'PUT', path: '/api/v1/carts/{id}/items/{id}', weight: 7, base: 73 },
  { method: 'POST', path: '/api/v1/payments', weight: 4, base: 310 },
  { method: 'GET', path: '/healthz', weight: 8, base: 2 },
  { method: 'GET', path: '/api/v1/reports/{id}/export', weight: 3, base: 880 },
] as const;

const SEARCH_WORDS = ['lamp', 'desk', 'chair', 'cable', 'monitor', 'shelf', 'mug', 'plant'];

function accessLog(seed: number, lineCount: number): { text: string; entries: AccessEntry[] } {
  const rng = new Rng(seed);
  const entries: AccessEntry[] = [];
  let clock = 9 * 3600 + rng.int(0, 59);
  for (let i = 0; i < lineCount; i++) {
    clock += rng.int(0, 2);
    const route = rng.weighted(LATENCY_ROUTES);
    let path: string = route.path.replace(/\{id\}/g, () => String(rng.int(1, 99_999)));
    if (route.path === '/api/v1/catalog/search') {
      path += `?q=${rng.pick(SEARCH_WORDS)}&page=${rng.int(1, 5)}`;
    } else if (route.path === '/api/v1/orders' && route.method === 'GET' && rng.chance(0.5)) {
      path += `?status=${rng.pick(['open', 'paid', 'shipped'])}&limit=50`;
    }
    let ms = Math.max(1, Math.round(route.base * (0.45 + rng.float() * 1.1)));
    if (rng.chance(0.04)) ms *= rng.int(3, 9);
    const roll = rng.float();
    let status: number;
    if (route.path === '/healthz') status = 200;
    else if (roll < 0.025) status = rng.pick([500, 502, 503]);
    else if (roll < 0.075) status = rng.pick([400, 404, 429]);
    else if (route.method === 'GET' && roll < 0.11) status = 304;
    else status = route.method === 'POST' ? 201 : route.method === 'DELETE' ? 204 : 200;
    const bytes =
      status === 204 || status === 304
        ? 0
        : route.path.endsWith('/export')
          ? rng.int(200_000, 2_500_000)
          : rng.int(120, 48_000);
    const ua =
      route.path === '/healthz'
        ? 'kube-probe/1.31'
        : rng.pick([
            'kilo-web/3.2.1',
            'kilo-web/3.2.1',
            'kilo-ios/5.14.0 (iPhone; iOS 19.1)',
            'kilo-android/5.13.2',
            'Go-http-client/2.0',
            'curl/8.5.0',
          ]);
    const ip = `10.${rng.int(0, 31)}.${rng.int(0, 255)}.${rng.int(1, 254)}`;
    const time = `${pad(Math.floor(clock / 3600), 2)}:${pad(Math.floor(clock / 60) % 60, 2)}:${pad(clock % 60, 2)}`;
    const seconds = `${Math.floor(ms / 1000)}.${pad(ms % 1000, 3)}`;
    const line = `${ip} - - [18/Nov/2026:${time} +0000] "${route.method} ${path} HTTP/1.1" ${status} ${bytes} ${seconds} "${ua}"`;
    entries.push({ line, method: route.method, path, status });
  }
  return { text: joinLines(entries.map(e => e.line)), entries };
}

type AccessEntry = { line: string; method: string; path: string; status: number };

function accessLatencyCase(): DeciderCase {
  const logs = [
    { name: 'logs/edge-01.log', ...accessLog(0xed6e01, 1200) },
    { name: 'logs/edge-02.log', ...accessLog(0xed6e02, 1200) },
    { name: 'logs/edge-03.log', ...accessLog(0xed6e03, 1200) },
  ];
  const files: Record<string, string> = {
    'README.md': joinLines([
      '# edge-logs',
      '',
      'Access logs pulled from the three edge proxies for the 18 Nov latency review.',
      'Format: ip - - [time] "METHOD path HTTP/1.1" status bytes latency_seconds "user agent"',
      '',
      'Reports go to out/ and are attached to the review ticket.',
    ]),
  };
  for (const log of logs) files[log.name] = log.text;

  const all = logs.flatMap(log => log.entries);
  const counts = new Map<string, number>();
  for (const entry of all) {
    const key = `${entry.method} ${entry.path.split('?')[0].replace(/\/[0-9]+/g, '/:id')}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const uniq = [...counts.keys()]
    .sort(byCodeUnit)
    .map(key => `${String(counts.get(key)).padStart(7)} ${key}`);
  const serverErrors = all.filter(e => e.status >= 500).map(e => e.line);

  return {
    id: 'cont-agent-tool-access-latency',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt: [
      'The current directory holds access logs from our three edge proxies (logs/*.log, see README.md for the line format). Build the per-route latency table for the latency review.',
      '',
      'Steps:',
      '1. Look at the log files and their format.',
      '2. Check which routes appear (method plus path) and how the 5xx responses look.',
      '3. Write a script (any language available here) that reads every line of every logs/*.log file and, ignoring lines whose status is 500 or higher, groups requests by route = METHOD + " " + normalized path. Normalize a path by dropping the query string (from "?" on) and replacing every path segment that consists only of digits with ":id" (so /api/v1/orders/48213 becomes /api/v1/orders/:id). Latency in milliseconds is the latency_seconds field times 1000 (it has exactly three decimals, so this is an integer).',
      '4. Run it to write out/latency.tsv: a header line "route\\tcount\\tp50_ms\\tp95_ms", then one line per route sorted by route in code-unit order, fields separated by a single tab, every line ending with "\\n". p50 and p95 use the nearest-rank method on the route\'s latencies sorted ascending: the value at 1-based rank ceil(p / 100 * count).',
      '5. Verify the file (route count, no 5xx included) and compute its SHA-256.',
      '',
      'Final answer: compact JSON with exactly these keys in this order: {"routes":<number of data lines in out/latency.tsv>,"excluded5xx":<number of log lines skipped for status >= 500>,"slowestP95":"<route with the highest p95_ms; on a tie the first in file order>","sha256":"<lowercase hex SHA-256 of out/latency.tsv>"}',
    ].join('\n'),
    requiredToolCalls: 1,
    continuation: {
      files,
      steps: [
        {
          text: "Let me see what's in the logs directory and what a log looks like.",
          calls: [
            bash(
              'for f in logs/*.log; do printf \'%s %s\\n\' "$f" "$(wc -l < "$f")"; done',
              'Count lines per log file',
              joinLines(logs.map(log => `${log.name} ${log.entries.length}`))
            ),
            bash(
              "sed -n '1,400p' logs/edge-01.log",
              'Show the first 400 lines of edge-01',
              sedRange(logs[0].text, 1, 400)
            ),
          ],
        },
        {
          text: 'Now the route inventory and the server errors that have to be excluded.',
          calls: [
            bash(
              "awk '{split($7, p, \"?\"); print substr($6, 2), p[1]}' logs/*.log | sed -E 's#/[0-9]+#/:id#g' | LC_ALL=C sort | uniq -c",
              'Count requests per normalized route',
              joinLines(uniq)
            ),
            bash(
              "grep -hE '\" 5[0-9]{2} ' logs/*.log",
              'List 5xx responses',
              joinLines(serverErrors)
            ),
            bash(
              'tail -n 400 logs/edge-03.log',
              'Show the end of edge-03',
              tailLines(logs[2].text, 400)
            ),
          ],
        },
      ],
      message: RESUME,
    },
    check: {
      kind: 'json_equal',
      value: {
        routes: 12,
        excluded5xx: 90,
        slowestP95: 'GET /api/v1/reports/:id/export',
        sha256: '052fcd57683f19c6facc011fd1ec2c439b3cde4e44c75c6f0671e37b8b87bb25',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// tool_usage: locale catalog sync (about 40k tokens)

// [en, de, fr, es]
const I18N_WORDS: readonly (readonly [string, string, string, string])[] = [
  ['account', 'Konto', 'compte', 'cuenta'],
  ['settings', 'Einstellungen', 'parametres', 'ajustes'],
  ['invoice', 'Rechnung', 'facture', 'factura'],
  ['payment', 'Zahlung', 'paiement', 'pago'],
  ['method', 'Methode', 'methode', 'metodo'],
  ['your', 'Ihr', 'votre', 'su'],
  ['the', 'die', 'le', 'el'],
  ['team', 'Team', 'equipe', 'equipo'],
  ['member', 'Mitglied', 'membre', 'miembro'],
  ['project', 'Projekt', 'projet', 'proyecto'],
  ['could', 'konnte', 'pourrait', 'podria'],
  ['not', 'nicht', 'pas', 'no'],
  ['be', 'werden', 'etre', 'ser'],
  ['saved', 'gespeichert', 'enregistre', 'guardado'],
  ['loaded', 'geladen', 'charge', 'cargado'],
  ['please', 'bitte', 'veuillez', 'por favor'],
  ['try', 'versuchen', 'essayer', 'intentar'],
  ['again', 'erneut', 'encore', 'de nuevo'],
  ['later', 'spater', 'plus tard', 'mas tarde'],
  ['new', 'neu', 'nouveau', 'nuevo'],
  ['order', 'Bestellung', 'commande', 'pedido'],
  ['cart', 'Warenkorb', 'panier', 'carrito'],
  ['empty', 'leer', 'vide', 'vacio'],
  ['search', 'Suche', 'recherche', 'busqueda'],
  ['results', 'Ergebnisse', 'resultats', 'resultados'],
  ['no', 'keine', 'aucun', 'ningun'],
  ['found', 'gefunden', 'trouve', 'encontrado'],
  ['for', 'fur', 'pour', 'para'],
  ['this', 'diese', 'ce', 'este'],
  ['is', 'ist', 'est', 'es'],
  ['required', 'erforderlich', 'requis', 'obligatorio'],
  ['email', 'E-Mail', 'e-mail', 'correo'],
  ['address', 'Adresse', 'adresse', 'direccion'],
  ['password', 'Passwort', 'mot de passe', 'contrasena'],
  ['sign', 'anmelden', 'connecter', 'iniciar'],
  ['in', 'in', 'dans', 'en'],
  ['out', 'aus', 'dehors', 'fuera'],
  ['with', 'mit', 'avec', 'con'],
  ['and', 'und', 'et', 'y'],
  ['to', 'zu', 'a', 'a'],
  ['of', 'von', 'de', 'de'],
  ['all', 'alle', 'tous', 'todos'],
  ['changes', 'Anderungen', 'modifications', 'cambios'],
  ['will', 'wird', 'va', 'va a'],
  ['update', 'aktualisieren', 'mettre a jour', 'actualizar'],
  ['delete', 'loschen', 'supprimer', 'eliminar'],
  ['plan', 'Tarif', 'forfait', 'plan'],
  ['billing', 'Abrechnung', 'facturation', 'facturacion'],
  ['notifications', 'Benachrichtigungen', 'notifications', 'notificaciones'],
  ['support', 'Support', 'assistance', 'soporte'],
  ['ticket', 'Ticket', 'ticket', 'ticket'],
  ['report', 'Bericht', 'rapport', 'informe'],
  ['download', 'herunterladen', 'telecharger', 'descargar'],
  ['export', 'exportieren', 'exporter', 'exportar'],
  ['link', 'Link', 'lien', 'enlace'],
  ['expired', 'abgelaufen', 'expire', 'caducado'],
  ['session', 'Sitzung', 'session', 'sesion'],
  ['now', 'jetzt', 'maintenant', 'ahora'],
  ['continue', 'fortfahren', 'continuer', 'continuar'],
  ['back', 'zuruck', 'retour', 'volver'],
  ['dashboard', 'Ubersicht', 'tableau de bord', 'panel'],
  ['usage', 'Nutzung', 'utilisation', 'uso'],
  ['limit', 'Limit', 'limite', 'limite'],
  ['reached', 'erreicht', 'atteint', 'alcanzado'],
];

const I18N_SECTIONS = [
  'account',
  'auth',
  'billing',
  'cart',
  'checkout',
  'common',
  'dashboard',
  'errors',
  'notifications',
  'onboarding',
  'orders',
  'profile',
  'search',
  'settings',
  'support',
  'team',
];
const I18N_GROUPS = ['actions', 'empty', 'filters', 'form', 'modal', 'table', 'toast', 'tooltips'];
const I18N_LEAVES = [
  'title',
  'description',
  'cta',
  'cancel',
  'confirm',
  'placeholder',
  'label',
  'help',
  'error',
  'success',
  'loading',
  'retry',
  'save',
  'close',
  'learnMore',
  'dismiss',
];

const CHECK_LOCALES_JS = joinLines([
  "'use strict';",
  '// Compares every translated catalog against locales/en.json.',
  "const fs = require('fs');",
  "const path = require('path');",
  '',
  "const dir = path.join(__dirname, '..', 'locales');",
  "const read = name => JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8'));",
  'const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);',
  '',
  "const en = read('en');",
  'const enKeys = Object.keys(en);',
  'let problems = 0;',
  "for (const locale of ['de', 'es', 'fr']) {",
  '  const data = read(locale);',
  '  const missing = enKeys.filter(key => !has(data, key));',
  '  const extra = Object.keys(data).filter(key => !has(en, key));',
  "  console.log(locale + ': ' + Object.keys(data).length + ' keys, missing ' + missing.length + ', extra ' + extra.length);",
  "  for (const key of missing) console.log('  - missing ' + key);",
  "  for (const key of extra) console.log('  + extra   ' + key);",
  '  problems += missing.length + extra.length;',
  '}',
  "console.log(problems === 0 ? 'OK: all locales in sync with en' : 'FAIL: ' + problems + ' problems');",
  'process.exitCode = problems === 0 ? 0 : 1;',
]);

function i18nValue(leaf: string, column: number, words: readonly number[]): string {
  const text = words.map(index => I18N_WORDS[index][column]).join(' ');
  const capital = text.charAt(0).toUpperCase() + text.slice(1);
  return leaf === 'description' || leaf === 'help' || leaf === 'error' || leaf === 'success'
    ? `${capital}.`
    : capital;
}

function i18nSyncCase(): DeciderCase {
  const rng = new Rng(0x118a);
  const combos: string[] = [];
  for (const section of I18N_SECTIONS) {
    for (const group of I18N_GROUPS) {
      for (const leaf of I18N_LEAVES) combos.push(`${section}.${group}.${leaf}`);
    }
  }
  const shuffled = rng.shuffle(combos);
  const enKeys = shuffled.slice(0, 700).sort(byCodeUnit);
  const spare = shuffled.slice(700);
  const phrase = new Map<string, number[]>();
  for (const key of [...enKeys, ...spare.slice(0, 40)]) {
    const leaf = key.slice(key.lastIndexOf('.') + 1);
    const long = leaf === 'description' || leaf === 'help' || leaf === 'error';
    const count = long ? rng.int(5, 9) : rng.int(2, 5);
    phrase.set(
      key,
      Array.from({ length: count }, () => rng.int(0, I18N_WORDS.length - 1))
    );
  }
  const valueOf = (key: string, column: number) => {
    const leaf = key.slice(key.lastIndexOf('.') + 1);
    const words = phrase.get(key);
    if (!words) throw new Error(`no phrase generated for ${key}`);
    let text = i18nValue(leaf, column, words);
    if (key.includes('.table.') && leaf === 'label') text += ' ({count})';
    return text;
  };
  const en: Record<string, string> = {};
  for (const key of enKeys) en[key] = valueOf(key, 0);

  const files: Record<string, string> = { 'locales/en.json': json2(en) };
  const outputs: Record<string, string> = {};
  const checkLines: string[] = [];
  let staleCursor = 0;
  const locales = [
    { code: 'de', column: 1, drop: 0.07, stale: 5 },
    { code: 'es', column: 3, drop: 0.11, stale: 3 },
    { code: 'fr', column: 2, drop: 0.05, stale: 7 },
  ];
  for (const locale of locales) {
    const keys = enKeys.filter(() => !rng.chance(locale.drop));
    for (let s = 0; s < locale.stale; s++) {
      const at = rng.int(0, keys.length);
      keys.splice(at, 0, spare[staleCursor++]);
    }
    const data: Record<string, string> = {};
    for (const key of keys) data[key] = valueOf(key, locale.column);
    files[`locales/${locale.code}.json`] = json2(data);
    const missing = enKeys.filter(key => !(key in data));
    const extra = keys.filter(key => !(key in en));
    checkLines.push(
      `${locale.code}: ${keys.length} keys, missing ${missing.length}, extra ${extra.length}`
    );
    for (const key of missing) checkLines.push(`  - missing ${key}`);
    for (const key of extra) checkLines.push(`  + extra   ${key}`);
    outputs[locale.code] = files[`locales/${locale.code}.json`];
  }
  const problems = checkLines.filter(line => line.startsWith('  ')).length;
  checkLines.push(`FAIL: ${problems} problems`);
  files['scripts/check-locales.js'] = CHECK_LOCALES_JS;
  files['package.json'] = json2({
    name: 'storefront-locales',
    private: true,
    scripts: { 'check:locales': 'node scripts/check-locales.js' },
  });

  return {
    id: 'cont-agent-tool-i18n-sync',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt: [
      'Our translated catalogs in locales/ (de, es, fr) drifted from the source catalog locales/en.json and `node scripts/check-locales.js` now fails in CI. Bring them back in sync.',
      '',
      'Steps:',
      '1. Read locales/en.json and the three translated catalogs.',
      '2. Run `node scripts/check-locales.js` to see the missing and extra keys.',
      '3. Update each of locales/de.json, locales/es.json and locales/fr.json: keep every existing translation of a key that exists in en.json unchanged; add every en.json key the catalog lacks with the value "[TODO] " followed by the English value; delete every key that is not in en.json. Write the catalog back with its keys in the same order as en.json, formatted exactly as JSON.stringify(catalog, null, 2) followed by one newline.',
      '4. Run `node scripts/check-locales.js` again; it must print "OK: all locales in sync with en".',
      '5. Compute the SHA-256 of the concatenation of locales/de.json, locales/es.json and locales/fr.json in that order (e.g. `cat locales/de.json locales/es.json locales/fr.json | sha256sum`).',
      '',
      'Final answer: compact JSON with exactly these keys in this order: {"added":{"de":<keys added to de>,"es":<keys added to es>,"fr":<keys added to fr>},"removed":<keys removed across all three>,"sha256":"<lowercase hex SHA-256 from step 5>"}',
    ].join('\n'),
    requiredToolCalls: 1,
    continuation: {
      files,
      steps: [
        {
          text: "I'll read the source catalog first.",
          calls: [
            bash(
              'cat locales/en.json',
              'Show the English source catalog',
              files['locales/en.json']
            ),
          ],
        },
        {
          text: 'Now the translated catalogs.',
          calls: [
            bash('cat locales/de.json', 'Show the German catalog', outputs.de),
            bash('cat locales/es.json', 'Show the Spanish catalog', outputs.es),
            bash('cat locales/fr.json', 'Show the French catalog', outputs.fr),
          ],
        },
        {
          text: 'And the checker output, which tells me exactly what drifted.',
          calls: [
            bash('node scripts/check-locales.js', 'Run the locale checker', joinLines(checkLines)),
          ],
        },
      ],
      message: RESUME,
    },
    check: {
      kind: 'json_equal',
      value: {
        added: { de: 40, es: 59, fr: 33 },
        removed: 15,
        sha256: 'cee7f9a7789fa9d80c95f34ecdcf4978aacc4fc90420d54adbdb0f877b0ebdb9',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// terminal_operations: prod env rollout with a regenerated manifest (about 12k tokens)

const ENV_SERVICES = [
  'accounts-api',
  'audit-log',
  'billing-api',
  'billing-worker',
  'cart-api',
  'catalog-api',
  'catalog-indexer',
  'checkout-api',
  'coupon-service',
  'edge-auth',
  'email-sender',
  'export-worker',
  'feature-flags',
  'fraud-scorer',
  'gateway',
  'geo-lookup',
  'image-resizer',
  'import-worker',
  'inventory-api',
  'invoice-renderer',
  'ledger-api',
  'notifications-api',
  'orders-api',
  'orders-worker',
  'payments-api',
  'payouts-worker',
  'pricing-api',
  'profile-api',
  'push-sender',
  'quota-service',
  'rate-limiter',
  'recommendations',
  'refunds-worker',
  'reports-api',
  'search-api',
  'session-store',
  'shipping-api',
  'sitemap-builder',
  'subscriptions-api',
  'support-api',
  'tax-service',
  'usage-meter',
  'webhooks-api',
  'webhooks-dispatcher',
  'wishlist-api',
  'workflow-engine',
  'xml-feeds',
  'zip-exporter',
  'analytics-ingest',
  'consent-service',
  'dunning-worker',
  'ledger-reconciler',
];

const STATELESS: Record<string, true> = {
  'edge-auth': true,
  gateway: true,
  'geo-lookup': true,
  'image-resizer': true,
  'push-sender': true,
  'rate-limiter': true,
  'sitemap-builder': true,
};

function envFile(rng: Rng, service: string, env: string, port: number): string {
  const lines = [
    `# ${service} (${env})`,
    `SERVICE_NAME=${service}`,
    `APP_ENV=${env}`,
    `LOG_LEVEL=${env === 'prod' ? 'warn' : env === 'staging' ? 'info' : 'debug'}`,
    `PORT=${port}`,
  ];
  if (!STATELESS[service]) {
    const pool =
      env === 'prod'
        ? rng.pick([8, 10, 12, 16, 16, 20, 24, 32])
        : env === 'staging'
          ? rng.pick([4, 6, 8])
          : 2;
    if (env === 'prod' && rng.chance(0.08))
      lines.push(`#DB_POOL_SIZE=${pool * 2} (pre-2025 sizing, keep for reference)`);
    lines.push(
      `DB_HOST=${service}-db.${env}.internal`,
      'DB_PORT=5432',
      `DB_NAME=${service.replace(/-/g, '_')}`,
      `DB_POOL_SIZE=${pool}`
    );
    if (rng.chance(0.55)) lines.push(`DB_POOL_TIMEOUT_MS=${rng.pick([2000, 3000, 8000])}`);
  }
  lines.push(
    `HTTP_TIMEOUT_MS=${rng.pick([5000, 10000, 15000, 30000])}`,
    `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.${env}.internal:4317`,
    `OTEL_SERVICE_NAME=${service}`
  );
  if (rng.chance(0.4)) {
    lines.push(
      `FEATURE_FLAGS=${rng.shuffle(['async-writes', 'new-pricing', 'eu-routing', 'shadow-reads']).slice(0, rng.int(1, 3)).join(',')}`
    );
  }
  return joinLines(lines);
}

function envRolloutCase(): DeciderCase {
  const rng = new Rng(0xe7e);
  const files: Record<string, string> = {};
  ENV_SERVICES.forEach((service, index) => {
    for (const env of ['dev', 'prod', 'staging']) {
      files[`deploy/${service}/${env}.env`] = envFile(rng, service, env, 8000 + index);
    }
  });
  files['deploy/README.md'] = joinLines([
    '# deploy',
    '',
    'One directory per service with dev.env, staging.env and prod.env.',
    'MANIFEST.sha256 lists the checksum of every env file; the release job refuses to ship when it is stale.',
    'Regenerate it from this directory with:',
    '',
    "    find . -name '*.env' -type f | LC_ALL=C sort | xargs sha256sum > MANIFEST.sha256",
  ]);
  const allPaths = Object.keys(files).sort(byCodeUnit);
  const prodPaths = allPaths.filter(p => p.endsWith('/prod.env'));
  const stagingPaths = allPaths.filter(p => p.endsWith('/staging.env'));
  const grep = prodPaths.flatMap(p =>
    linesOf(files[p])
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.includes('DB_POOL'))
      .map(({ line, n }) => `${p}:${n}:${line}`)
  );
  const dump = (paths: readonly string[]) => paths.map(p => `==> ${p} <==\n${files[p]}`).join('');

  return {
    id: 'cont-agent-term-env-rollout',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt: [
      'Production databases are running out of pooled connections. Roll out the new pool settings to the prod env files under deploy/ from the shell (sed/awk/etc.), then regenerate the manifest.',
      '',
      'Steps:',
      '1. List the env files under deploy/.',
      '2. Look at the current DB_POOL settings in every deploy/*/prod.env (also compare with staging).',
      '3. In every deploy/*/prod.env that has a line beginning with `DB_POOL_SIZE=`: if its value is below 20, change that line to `DB_POOL_SIZE=20`; and if the file has no line beginning with `DB_POOL_TIMEOUT_MS=`, insert the line `DB_POOL_TIMEOUT_MS=5000` directly after the DB_POOL_SIZE line. Commented lines (starting with #) are not settings and must stay unchanged. Do not touch dev.env or staging.env files, and change nothing else.',
      "4. From inside deploy/, regenerate the manifest exactly as deploy/README.md says: `find . -name '*.env' -type f | LC_ALL=C sort | xargs sha256sum > MANIFEST.sha256`.",
      '5. Verify the edits (grep the DB_POOL lines again) and compute the SHA-256 of deploy/MANIFEST.sha256.',
      '',
      'Final answer: compact JSON with exactly these keys in this order: {"raised":<number of prod.env files whose DB_POOL_SIZE was raised to 20>,"timeoutAdded":<number of prod.env files that got the DB_POOL_TIMEOUT_MS=5000 line>,"manifestSha256":"<lowercase hex SHA-256 of deploy/MANIFEST.sha256>"}',
    ].join('\n'),
    requiredToolCalls: 1,
    continuation: {
      files,
      steps: [
        {
          text: "I'll start by listing the env files.",
          calls: [
            bash(
              'find deploy -type f | LC_ALL=C sort',
              'List files under deploy',
              joinLines(allPaths)
            ),
            bash(
              "find deploy -name prod.env | LC_ALL=C sort | xargs grep -n 'DB_POOL'",
              'Show DB_POOL lines in prod env files',
              joinLines(grep)
            ),
          ],
        },
        {
          text: 'Let me read the prod files in full, and staging for comparison.',
          calls: [
            bash(
              'for f in $(find deploy -name prod.env | LC_ALL=C sort); do echo "==> $f <=="; cat "$f"; done',
              'Show every prod.env',
              dump(prodPaths)
            ),
            bash(
              'for f in $(find deploy -name staging.env | LC_ALL=C sort); do echo "==> $f <=="; cat "$f"; done',
              'Show every staging.env',
              dump(stagingPaths)
            ),
          ],
        },
      ],
      message: RESUME,
    },
    check: {
      kind: 'json_equal',
      value: {
        raised: 31,
        timeoutAdded: 22,
        manifestSha256: '54c2eaed5bdd36b79e02f096e83c88d70f21d1edf5e6ce0d31d63f7fdbc44b78',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// terminal_operations: split an application log by level, keeping multi-line entries (about 25k tokens)

const LOG_COMPONENTS = [
  'api.http',
  'orders.sync',
  'payments.charge',
  'payments.webhook',
  'auth.session',
  'search.index',
  'mailer.send',
  'cache.redis',
  'scheduler.cron',
  'billing.invoice',
];

const STACK_FRAMES = [
  'chargeCard (src/payments/charge.js:88:13)',
  'async Promise.all (index 2)',
  'processTicksAndRejections (node:internal/process/task_queues:95:5)',
  'async OrdersSync.run (src/orders/sync.js:141:7)',
  'Pool.acquire (node_modules/pg-pool/index.js:45:11)',
  'RedisClient.send (node_modules/@redis/client/dist/lib/client/index.js:512:30)',
  'Router.handle (src/http/router.js:212:18)',
  'renderInvoice (src/billing/render.js:61:22)',
  'Mailer.deliver (src/mailer/smtp.js:97:15)',
  'Indexer.flush (src/search/indexer.js:174:9)',
];

function appLog(): string {
  const rng = new Rng(0x1096);
  const lines: string[] = [];
  let ms = 9 * 3_600_000;
  for (let i = 0; i < 2300; i++) {
    ms += rng.int(3, 900);
    const roll = rng.float();
    const level = roll < 0.3 ? 'DEBUG' : roll < 0.85 ? 'INFO' : roll < 0.95 ? 'WARN' : 'ERROR';
    const component = rng.pick(LOG_COMPONENTS);
    const thread = rng.chance(0.5) ? `worker-${rng.int(1, 8)}` : `http-${rng.int(1, 16)}`;
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor(ms / 60_000) % 60;
    const s = Math.floor(ms / 1000) % 60;
    const ts = `2026-11-18T${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms % 1000, 3)}Z`;
    const req = rng.hex(8);
    let message: string;
    const extra: string[] = [];
    if (level === 'DEBUG') {
      message = rng.pick([
        `cache hit key=sku:${rng.int(1000, 9999)} ttl=${rng.int(10, 600)}s`,
        `query took ${rng.int(1, 80)}ms rows=${rng.int(0, 500)}`,
        `acquired lock jobs:${rng.hex(6)} after ${rng.int(0, 40)}ms`,
        `payload size ${rng.int(200, 90000)} bytes`,
      ]);
    } else if (level === 'INFO') {
      message = rng.pick([
        `synced ${rng.int(1, 60)} orders in ${rng.int(20, 900)}ms`,
        `GET /api/v1/orders/${rng.int(1, 99999)} 200 ${rng.int(3, 300)}ms`,
        `session refreshed user=u_${rng.int(1000, 99999)}`,
        `sent template=receipt to=${rng.hex(10)}@mail.example`,
        `invoice inv_${rng.hex(8)} rendered pages=${rng.int(1, 6)}`,
        `cron job=${rng.pick(['cleanup', 'usage-rollup', 'dunning'])} finished in ${rng.int(100, 9000)}ms`,
      ]);
      if (rng.chance(0.03)) {
        message = 'config reloaded:';
        extra.push(`  pool.max=${rng.int(10, 40)}`, `  http.timeout_ms=${rng.pick([5000, 15000])}`);
        if (rng.chance(0.5)) extra.push(`  flags=${rng.pick(['async-writes', 'eu-routing'])}`);
      }
    } else if (level === 'WARN') {
      message = rng.pick([
        `slow query ${rng.int(800, 6000)}ms on table=${rng.pick(['orders', 'invoices', 'sessions'])}`,
        `upstream returned 429, backing off`,
        `retrying webhook delivery wh_${rng.hex(8)}`,
        `connection pool at ${rng.int(85, 100)}% capacity`,
      ]);
      if (rng.chance(0.4)) extra.push(`    retry ${rng.int(2, 5)}/5 in ${rng.int(1, 9) * 100}ms`);
    } else {
      const errorName = rng.pick(['PaymentError', 'TimeoutError', 'DatabaseError', 'TypeError']);
      message = rng.pick([
        `charge failed for invoice inv_${rng.hex(8)}`,
        `sync aborted after ${rng.int(1, 9)} attempts`,
        `request failed with unhandled exception`,
        `could not render invoice inv_${rng.hex(8)}`,
      ]);
      extra.push(
        `  ${errorName}: ${rng.pick(['card_declined (code=402)', 'operation timed out after 30000ms', 'connection terminated unexpectedly', "Cannot read properties of undefined (reading 'id')"])}`
      );
      const frames = rng.int(2, 6);
      for (let f = 0; f < frames; f++) extra.push(`    at ${rng.pick(STACK_FRAMES)}`);
      if (rng.chance(0.3)) {
        extra.push('  Caused by: Error: socket hang up');
        extra.push(`    at ${rng.pick(STACK_FRAMES)}`);
      }
    }
    lines.push(`${ts} ${level.padEnd(5)} [${thread}] ${component} req=${req} ${message}`, ...extra);
  }
  return joinLines(lines);
}

function grepAfter(text: string, needle: string, after: number): string[] {
  const lines = linesOf(text);
  const out: string[] = [];
  let last = -1;
  let remaining = 0;
  lines.forEach((line, i) => {
    if (line.includes(needle)) {
      if (last >= 0 && i > last + 1) out.push('--');
      out.push(`${i + 1}:${line}`);
      last = i;
      remaining = after;
    } else if (remaining > 0) {
      out.push(`${i + 1}-${line}`);
      last = i;
      remaining--;
    }
  });
  return out;
}

function logSplitCase(): DeciderCase {
  const log = appLog();
  const files = {
    'var/log/app.log': log,
    'NOTES.md': joinLines([
      '# incident 2026-11-18 checkout errors',
      '',
      '- app.log is the raw node log from the checkout pod (UTC timestamps).',
      '- Errors carry stack traces on the following indented lines; WARN entries sometimes carry an indented retry line.',
      '- Split per level under out/ for the postmortem attachments.',
    ]),
  };
  const lines = linesOf(log);
  const errorCount = lines.filter(l => l.includes(' ERROR ')).length;
  const warnCount = lines.filter(l => l.includes(' WARN ')).length;
  const indented = lines.filter(l => l.startsWith(' ')).length;
  const warnLines = lines
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes(' WARN '))
    .slice(0, 180)
    .map(({ line, n }) => `${n}:${line}`);

  return {
    id: 'cont-agent-term-log-split',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt: [
      'For the checkout incident postmortem, split var/log/app.log by log level using shell tools (awk, grep, sed, ...).',
      '',
      'Steps:',
      '1. Look at the log: its size, line format and how multi-line entries look.',
      '2. Count the ERROR and WARN lines and look at the error entries with their stack traces.',
      '3. Split the log into out/ERROR.log, out/WARN.log, out/INFO.log and out/DEBUG.log. An entry starts at a line that begins with a timestamp (a digit) and includes every following line that begins with whitespace. The level is the second whitespace-separated field of the entry\'s first line. Write each complete entry, byte-for-byte unchanged, to the file of its level, keeping the original order; every line ends with "\\n" as in the source.',
      '4. Verify that the four files together have exactly as many lines as var/log/app.log, then compute the SHA-256 of out/ERROR.log and out/WARN.log.',
      '',
      'Final answer: compact JSON with exactly these keys in this order: {"entries":{"ERROR":<entries>,"WARN":<entries>,"INFO":<entries>,"DEBUG":<entries>},"errorLines":<lines in out/ERROR.log>,"errorSha256":"<lowercase hex SHA-256 of out/ERROR.log>","warnSha256":"<lowercase hex SHA-256 of out/WARN.log>"}',
    ].join('\n'),
    requiredToolCalls: 1,
    continuation: {
      files,
      steps: [
        {
          text: "Let me look at the log's size and the first part of it.",
          calls: [
            bash('wc -l < var/log/app.log', 'Count log lines', `${lines.length}\n`),
            bash(
              "sed -n '1,480p' var/log/app.log",
              'Show the first 480 log lines',
              sedRange(log, 1, 480)
            ),
          ],
        },
        {
          text: 'Now the error and warning entries, including their indented continuation lines.',
          calls: [
            bash(
              "grep -c ' ERROR ' var/log/app.log; grep -c ' WARN ' var/log/app.log; grep -c '^ ' var/log/app.log",
              'Count ERROR, WARN and indented lines',
              `${errorCount}\n${warnCount}\n${indented}\n`
            ),
            bash(
              "grep -n -A6 ' ERROR ' var/log/app.log | head -n 520",
              'Show ERROR entries with context',
              joinLines(grepAfter(log, ' ERROR ', 6).slice(0, 520))
            ),
            bash(
              "grep -n ' WARN ' var/log/app.log | head -n 180",
              'Show WARN lines',
              joinLines(warnLines)
            ),
          ],
        },
      ],
      message: RESUME,
    },
    check: {
      kind: 'json_equal',
      value: {
        entries: { ERROR: 117, WARN: 245, INFO: 1259, DEBUG: 679 },
        errorLines: 806,
        errorSha256: 'a53c36e3698734c9eda828c4b6e2a1a1773a90e13e05fb6953a7cefb0f266f78',
        warnSha256: '73ece6268532fc6012309294ba20452fd19ed120a1be00427135bb6eab71e1e9',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// terminal_operations: renumber colliding migrations after a merge (about 40k tokens)

const MIGRATION_TABLES = [
  'users',
  'organizations',
  'memberships',
  'invoices',
  'invoice_lines',
  'payments',
  'payouts',
  'subscriptions',
  'plans',
  'coupons',
  'api_keys',
  'webhooks',
  'webhook_deliveries',
  'audit_events',
  'sessions',
  'feature_flags',
  'usage_records',
  'credit_grants',
  'refunds',
  'tax_rates',
  'addresses',
  'notifications',
  'exports',
  'imports',
  'teams',
  'projects',
  'deployments',
  'secrets',
  'quotas',
  'regions',
];
const MIGRATION_COLUMNS = [
  'external_id',
  'archived_at',
  'region',
  'currency',
  'metadata',
  'display_name',
  'locale',
  'deleted_at',
  'priority',
  'retry_count',
  'last_seen_at',
  'status',
  'source',
  'notes',
];
const MIGRATION_AUTHORS = ['akim', 'bea.l', 'chen.w', 'dmitri', 'esra', 'fatima.o', 'goran'];
const MIGRATION_PROSE = [
  'Keeps reads on the hot path index-only; the planner picked a sequential scan before this.',
  'Requested by the billing team for the EU rollout (data must stay in the EU region).',
  'Backfill runs in batches of 5000 rows to keep replication lag on the read replicas low.',
  'Safe to run online: no table rewrite, only a catalog change under a short lock.',
  'The application tolerates both shapes until the next release removes the old code path.',
  'Nullable first; the NOT NULL constraint follows once the backfill has completed everywhere.',
  'Matches the retention policy agreed in the quarterly data review with legal.',
  'Dropping the column is deferred until all readers are gone (see the deprecation dashboard).',
  'Partial index: only live rows are queried, soft-deleted rows are excluded on purpose.',
  'Foreign key validated separately to avoid holding a long ACCESS EXCLUSIVE lock.',
  'Tested against a production snapshot restored on the staging cluster, runtime under 40s.',
  'The ORM model already declares this field, so no application deploy is needed first.',
  'Rows written before 2024 never had this value; the default mirrors what the API returned.',
  'Monitoring: watch pg_stat_activity for lock waits on this table while the migration runs.',
];

type Migration = { id: string; branch: string; author: string; body: string };

function migrationBody(rng: Rng, name: string, table: string, column: string): string[] {
  const lines = [
    `-- ticket: ${rng.pick(['PLAT', 'BILL', 'CORE'])}-${rng.int(100, 999)}`,
    `-- reviewed-by: ${rng.pick(MIGRATION_AUTHORS)}`,
    '--',
    '-- Context:',
  ];
  const prose = rng.int(6, 10);
  for (let i = 0; i < prose; i++) lines.push(`--   ${rng.pick(MIGRATION_PROSE)}`);
  const rollback: string[] = [];
  lines.push(
    '',
    'BEGIN;',
    '',
    "SET LOCAL lock_timeout = '5s';",
    "SET LOCAL statement_timeout = '15min';",
    ''
  );
  if (name.startsWith('create_')) {
    lines.push(`CREATE TABLE ${table} (`);
    lines.push('  id BIGSERIAL PRIMARY KEY,');
    const columns = rng.shuffle(MIGRATION_COLUMNS).slice(0, rng.int(4, 7));
    for (const c of columns) {
      const type = c.endsWith('_at')
        ? 'TIMESTAMPTZ'
        : c === 'metadata'
          ? "JSONB NOT NULL DEFAULT '{}'::jsonb"
          : c === 'priority' || c === 'retry_count'
            ? 'INTEGER NOT NULL DEFAULT 0'
            : 'TEXT';
      lines.push(`  ${c} ${type},`);
    }
    lines.push('  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),');
    lines.push('  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()');
    lines.push(');', '');
    lines.push(`CREATE INDEX ${table}_created_at_idx ON ${table} (created_at);`);
    lines.push(
      `COMMENT ON TABLE ${table} IS '${table.replace(/_/g, ' ')} owned by the platform team';`
    );
    lines.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO app_rw;`);
    lines.push(`GRANT SELECT ON ${table} TO app_ro;`);
    rollback.push(`DROP TABLE IF EXISTS ${table};`);
  } else if (name.startsWith('add_')) {
    lines.push(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT;`);
    lines.push(
      `COMMENT ON COLUMN ${table}.${column} IS 'see ${rng.pick(['PLAT', 'BILL', 'CORE'])}-${rng.int(100, 999)}';`
    );
    rollback.push(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${column};`);
  } else if (name.startsWith('index_')) {
    lines.push(
      `CREATE INDEX ${table}_${column}_idx ON ${table} (${column}) WHERE deleted_at IS NULL;`
    );
    rollback.push(`DROP INDEX IF EXISTS ${table}_${column}_idx;`);
  } else if (name.startsWith('backfill_')) {
    lines.push(`UPDATE ${table}`);
    lines.push(
      `SET ${column} = COALESCE(${column}, '${rng.pick(['unknown', 'eu-west', 'EUR', 'en'])}')`
    );
    lines.push(`WHERE ${column} IS NULL`);
    lines.push(
      `  AND id IN (SELECT id FROM ${table} WHERE ${column} IS NULL ORDER BY id LIMIT 5000);`
    );
    rollback.push('-- data backfill, nothing to roll back');
  } else {
    lines.push(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${column};`);
    rollback.push(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT; -- data is not restored`);
  }
  lines.push('', 'COMMIT;', '', '-- Rollback:', ...rollback.map(line => `--   ${line}`));
  lines.push('-- Verification:', `--   SELECT count(*) FROM ${table};`);
  if (column) lines.push(`--   SELECT count(*) FROM ${table} WHERE ${column} IS NULL;`);
  return lines;
}

const VERIFY_MIGRATIONS_JS = joinLines([
  "'use strict';",
  '// Verifies db/migrations before deploy: unique contiguous numbers, headers, journal.',
  "const fs = require('fs');",
  "const path = require('path');",
  "const crypto = require('crypto');",
  '',
  "const dir = path.join(__dirname, '..', 'db', 'migrations');",
  "const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();",
  "const journal = JSON.parse(fs.readFileSync(path.join(dir, 'journal.json'), 'utf8'));",
  'const errors = [];',
  'const seen = new Map();',
  'for (const file of files) {',
  '  const m = /^(\\d{4})_([a-z0-9_]+)\\.sql$/.exec(file);',
  '  if (!m) {',
  "    errors.push('bad file name: ' + file);",
  '    continue;',
  '  }',
  '  const num = Number(m[1]);',
  "  if (seen.has(num)) errors.push('duplicate number ' + m[1] + ': ' + seen.get(num) + ' and ' + file);",
  '  else seen.set(num, file);',
  "  const header = fs.readFileSync(path.join(dir, file), 'utf8').split('\\n', 1)[0];",
  "  if (header !== '-- migration: ' + file.slice(0, -4)) errors.push('header mismatch in ' + file + ': ' + header);",
  '}',
  'const numbers = [...seen.keys()].sort((a, b) => a - b);',
  'for (let i = 0; i < numbers.length; i++) {',
  '  if (numbers[i] !== i + 1) {',
  "    errors.push('gap: expected ' + String(i + 1).padStart(4, '0') + ', found ' + String(numbers[i]).padStart(4, '0'));",
  '    break;',
  '  }',
  '}',
  'const listed = journal.migrations.map(entry => entry.file);',
  'for (let i = 0; i < Math.max(listed.length, files.length); i++) {',
  '  if (listed[i] !== files[i]) {',
  "    errors.push('journal out of sync at position ' + (i + 1) + ': journal has ' + (listed[i] ?? '(none)') + ', directory has ' + (files[i] ?? '(none)'));",
  '    break;',
  '  }',
  '}',
  'if (errors.length > 0) {',
  "  for (const error of errors) console.log('ERROR ' + error);",
  "  console.log('FAILED with ' + errors.length + ' error(s)');",
  '  process.exitCode = 1;',
  '} else {',
  "  const hash = crypto.createHash('sha256');",
  '  for (const file of files) {',
  "    hash.update(file + '\\n');",
  '    hash.update(fs.readFileSync(path.join(dir, file)));',
  '  }',
  "  console.log('OK ' + files.length + ' migrations, last ' + files[files.length - 1] + ', sha256 ' + hash.digest('hex'));",
  '}',
]);

function migrationRenumberCase(): DeciderCase {
  const rng = new Rng(0xdb0113);
  const used = new Set<string>();
  const main: Migration[] = [];
  const nameFor = (index: number): { name: string; table: string; column: string } => {
    if (index < MIGRATION_TABLES.length) {
      const table = MIGRATION_TABLES[index];
      return { name: `create_${table}`, table, column: '' };
    }
    for (;;) {
      const table = rng.pick(MIGRATION_TABLES);
      const column = rng.pick(MIGRATION_COLUMNS);
      const kind = rng.pick(['add', 'add', 'index', 'backfill', 'drop']);
      const name =
        kind === 'add'
          ? `add_${column}_to_${table}`
          : kind === 'index'
            ? `index_${table}_on_${column}`
            : kind === 'backfill'
              ? `backfill_${table}_${column}`
              : `drop_${column}_from_${table}`;
      if (!used.has(name)) return { name, table, column };
    }
  };
  for (let i = 0; i < 116; i++) {
    const { name, table, column } = nameFor(i);
    used.add(name);
    const id = `${pad(i + 1, 4)}_${name}`;
    const author = rng.pick(MIGRATION_AUTHORS);
    main.push({
      id,
      branch: 'main',
      author,
      body: joinLines([
        `-- migration: ${id}`,
        '-- branch: main',
        `-- author: ${author}`,
        ...migrationBody(rng, name, table, column),
      ]),
    });
  }
  const featureBodies: [string, string[]][] = [
    [
      'add_invoice_notes',
      [
        '-- Free-text notes on invoices, shown on the PDF and in the customer portal.',
        '',
        'BEGIN;',
        '',
        'CREATE TABLE invoice_notes (',
        '  id BIGSERIAL PRIMARY KEY,',
        '  invoice_id BIGINT NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,',
        '  author_id BIGINT REFERENCES users (id),',
        '  body TEXT NOT NULL,',
        "  visibility TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'customer')),",
        '  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),',
        '  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()',
        ');',
        '',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_notes TO app_rw;',
        'GRANT SELECT ON invoice_notes TO app_ro;',
        '',
        'COMMIT;',
      ],
    ],
    [
      'backfill_invoice_notes',
      [
        '-- depends on: 0113_add_invoice_notes',
        '-- Moves the legacy invoices.memo column into invoice_notes.',
        '',
        'BEGIN;',
        '',
        'INSERT INTO invoice_notes (invoice_id, body, visibility, created_at)',
        "SELECT id, memo, 'customer', created_at",
        'FROM invoices',
        "WHERE memo IS NOT NULL AND memo <> '';",
        '',
        'COMMIT;',
      ],
    ],
    [
      'index_invoice_notes',
      [
        '-- depends on: 0113_add_invoice_notes',
        '-- The portal lists notes per invoice, newest first.',
        '',
        'BEGIN;',
        '',
        'CREATE INDEX invoice_notes_invoice_id_created_at_idx ON invoice_notes (invoice_id, created_at DESC);',
        '',
        'COMMIT;',
      ],
    ],
    [
      'invoice_notes_audit_trigger',
      [
        '-- depends on: 0113_add_invoice_notes, 0115_index_invoice_notes',
        '-- Every change to a customer-visible note lands in audit_events.',
        '',
        'BEGIN;',
        '',
        'CREATE FUNCTION invoice_notes_audit() RETURNS trigger AS $$',
        'BEGIN',
        '  INSERT INTO audit_events (kind, subject_id, payload)',
        "  VALUES ('invoice_note.' || lower(TG_OP), NEW.invoice_id, to_jsonb(NEW));",
        '  RETURN NEW;',
        'END;',
        '$$ LANGUAGE plpgsql;',
        '',
        'CREATE TRIGGER invoice_notes_audit_trg',
        'AFTER INSERT OR UPDATE ON invoice_notes',
        "FOR EACH ROW WHEN (NEW.visibility = 'customer')",
        'EXECUTE FUNCTION invoice_notes_audit();',
        '',
        'COMMIT;',
      ],
    ],
  ];
  const feature: Migration[] = featureBodies.map(([name, body], i) => {
    const id = `${pad(113 + i, 4)}_${name}`;
    return {
      id,
      branch: 'feature/invoice-notes',
      author: 'fatima.o',
      body: joinLines([
        `-- migration: ${id}`,
        '-- branch: feature/invoice-notes',
        '-- author: fatima.o',
        '',
        ...body,
      ]),
    };
  });
  const files: Record<string, string> = {};
  for (const m of [...main, ...feature]) files[`db/migrations/${m.id}.sql`] = m.body;
  files['db/migrations/journal.json'] = json2({
    version: 3,
    migrations: [...main, ...feature].map(m => ({
      file: `${m.id}.sql`,
      branch: m.branch,
      author: m.author,
    })),
  });
  files['scripts/verify-migrations.js'] = VERIFY_MIGRATIONS_JS;

  const sqlNames = Object.keys(files)
    .filter(p => p.endsWith('.sql'))
    .map(p => p.slice('db/migrations/'.length))
    .sort(byCodeUnit);
  const listing = [...sqlNames, 'journal.json'].sort(byCodeUnit);
  const verifyErrors: string[] = [];
  const seen = new Map<number, string>();
  for (const file of sqlNames) {
    const num = Number(file.slice(0, 4));
    const prior = seen.get(num);
    if (prior) verifyErrors.push(`duplicate number ${file.slice(0, 4)}: ${prior} and ${file}`);
    else seen.set(num, file);
  }
  const journalOrder = [...main, ...feature].map(m => `${m.id}.sql`);
  const firstDiff = journalOrder.findIndex((file, i) => file !== sqlNames[i]);
  verifyErrors.push(
    `journal out of sync at position ${firstDiff + 1}: journal has ${journalOrder[firstDiff]}, directory has ${sqlNames[firstDiff]}`
  );
  const verifyOutput = joinLines([
    ...verifyErrors.map(e => `ERROR ${e}`),
    `FAILED with ${verifyErrors.length} error(s)`,
  ]);
  const group = (prefixes: readonly string[]) =>
    sqlNames
      .filter(name => prefixes.some(prefix => name.startsWith(prefix)))
      .map(name => `db/migrations/${name}`);
  const findGroup = (prefixes: readonly string[]) =>
    `find db/migrations ${prefixes.map(p => `-name '${p}*.sql'`).join(' -o ')} | LC_ALL=C sort | xargs tail -n +1`;
  const groupA = ['009', '010', '011'];
  const groupB = ['006', '007', '008'];
  const groupC = ['003', '004', '005'];

  return {
    id: 'cont-agent-term-migration-renumber',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt: [
      'Merging feature/invoice-notes into main left db/migrations with colliding migration numbers, and `node scripts/verify-migrations.js` (our pre-deploy gate) fails. Fix it from the shell.',
      '',
      'Steps:',
      '1. List db/migrations and read db/migrations/journal.json.',
      '2. Run `node scripts/verify-migrations.js` and read the script to see what it checks.',
      '3. Look at the SQL of the recent migrations to understand the collision.',
      '4. Renumber: main keeps its numbers. The migrations that came from feature/invoice-notes (branch field in the journal) move after the last main migration, numbered consecutively in their current relative order, keeping their names (e.g. 0113_add_invoice_notes.sql becomes 0117_add_invoice_notes.sql if main ends at 0116). Rename the files with mv, and inside each renamed file replace every occurrence of an old feature migration id (like 0113_add_invoice_notes) with its new id, including the "-- migration:" header and "-- depends on:" lines. Update the "file" values of those journal entries and reorder journal.migrations by file name; keep every other field and write the journal as JSON.stringify(journal, null, 2) plus a newline.',
      '5. Run `node scripts/verify-migrations.js` again; it must print an OK line with a sha256.',
      '',
      'Final answer: compact JSON with exactly these keys in this order: {"migrations":<count from the OK line>,"last":"<last file name from the OK line>","sha256":"<sha256 from the OK line>"}',
    ].join('\n'),
    requiredToolCalls: 1,
    continuation: {
      files,
      steps: [
        {
          text: "I'll look at the migrations directory and the journal first.",
          calls: [
            bash('LC_ALL=C ls -1 db/migrations', 'List migrations', joinLines(listing)),
            bash(
              'cat db/migrations/journal.json',
              'Show the migration journal',
              files['db/migrations/journal.json']
            ),
          ],
        },
        {
          text: 'Now the gate itself: what it reports and what it checks.',
          calls: [
            bash('node scripts/verify-migrations.js', 'Run the migration gate', verifyOutput),
            bash('cat scripts/verify-migrations.js', 'Show the gate script', VERIFY_MIGRATIONS_JS),
          ],
        },
        {
          text: 'Let me read the SQL of the migrations around the collision, plus earlier ones touching the same tables.',
          calls: [
            bash(
              findGroup(groupA),
              'Show migrations 0090-0116',
              multiFileTail(group(groupA), files)
            ),
            bash(
              findGroup(groupB),
              'Show migrations 0060-0089',
              multiFileTail(group(groupB), files)
            ),
            bash(
              findGroup(groupC),
              'Show migrations 0030-0059',
              multiFileTail(group(groupC), files)
            ),
          ],
        },
      ],
      message: RESUME,
    },
    check: {
      kind: 'json_equal',
      value: {
        migrations: 120,
        last: '0120_invoice_notes_audit_trigger.sql',
        sha256: '2d9d2074cf8702e12a75c6b1ff668161499abdf9b9d664be79aba960cfb79dc3',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// multi_step_execution: fix pricing rounding, test, build quotes (about 12k tokens)

const PRICING_JS = joinLines([
  "'use strict';",
  '',
  '/** Rounds an amount in cents to whole cents. */',
  'function roundCents(value) {',
  '  return Math.round(value);',
  '}',
  '',
  '/**',
  ' * Prices one order. Amounts are integer cents; rates are basis points (1/100 of a percent).',
  ' * @param {{ lines: { sku: string, qty: number, unitCents: number }[], discountBps: number, taxBps: number }} order',
  ' */',
  'function priceOrder(order) {',
  '  const subtotal = order.lines.reduce((sum, line) => sum + line.qty * line.unitCents, 0);',
  '  const tax = roundCents((subtotal * order.taxBps) / 10000);',
  '  const discount = roundCents((subtotal * order.discountBps) / 10000);',
  '  const total = subtotal - discount + tax;',
  '  return { subtotal, discount, tax, total };',
  '}',
  '',
  'module.exports = { priceOrder, roundCents };',
]);

const PRICING_RUN_JS = joinLines([
  "'use strict';",
  '// Minimal TAP-style runner for the pricing cases.',
  "const { priceOrder } = require('../src/pricing');",
  "const cases = require('./pricing.cases.json');",
  '',
  "const KEYS = ['subtotal', 'discount', 'tax', 'total'];",
  'let pass = 0;',
  'let fail = 0;',
  'cases.forEach((c, i) => {',
  '  const got = priceOrder(c.order);',
  '  const diff = KEYS.filter(key => got[key] !== c.expected[key]);',
  '  if (diff.length === 0) {',
  '    pass++;',
  "    console.log('ok ' + (i + 1) + ' - ' + c.name);",
  '    return;',
  '  }',
  '  fail++;',
  "  console.log('not ok ' + (i + 1) + ' - ' + c.name);",
  "  for (const key of diff) console.log('    ' + key + ': expected ' + c.expected[key] + ', got ' + got[key]);",
  '});',
  "console.log('# tests ' + cases.length);",
  "console.log('# pass ' + pass);",
  "console.log('# fail ' + fail);",
  'process.exitCode = fail === 0 ? 0 : 1;',
]);

const BUILD_QUOTES_JS = joinLines([
  "'use strict';",
  '// Prices every order in data/orders.jsonl and writes out/quotes.csv for the sales export.',
  "const fs = require('fs');",
  "const path = require('path');",
  "const { priceOrder } = require('../src/pricing');",
  '',
  "const ROOT = path.join(__dirname, '..');",
  'const orders = fs',
  "  .readFileSync(path.join(ROOT, 'data', 'orders.jsonl'), 'utf8')",
  "  .split('\\n')",
  '  .filter(Boolean)',
  '  .map(line => JSON.parse(line));',
  "const rows = ['order_id,customer,subtotal,discount,tax,total'];",
  'for (const order of orders) {',
  '  const p = priceOrder(order);',
  "  rows.push([order.id, order.customer, p.subtotal, p.discount, p.tax, p.total].join(','));",
  '}',
  "fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });",
  "fs.writeFileSync(path.join(ROOT, 'out', 'quotes.csv'), rows.join('\\n') + '\\n');",
  "console.log('wrote out/quotes.csv (' + orders.length + ' orders)');",
]);

type PricedOrder = {
  lines: { sku: string; qty: number; unitCents: number }[];
  discountBps: number;
  taxBps: number;
};

function halfEven(numerator: number): number {
  const q = Math.floor(numerator / 10000);
  const r = numerator - q * 10000;
  return r > 5000 || (r === 5000 && q % 2 === 1) ? q + 1 : q;
}

function priceCorrect(order: PricedOrder) {
  const subtotal = order.lines.reduce((sum, line) => sum + line.qty * line.unitCents, 0);
  const discount = halfEven(subtotal * order.discountBps);
  const tax = halfEven((subtotal - discount) * order.taxBps);
  return { subtotal, discount, tax, total: subtotal - discount + tax };
}

function priceBuggy(order: PricedOrder) {
  const subtotal = order.lines.reduce((sum, line) => sum + line.qty * line.unitCents, 0);
  const tax = Math.round((subtotal * order.taxBps) / 10000);
  const discount = Math.round((subtotal * order.discountBps) / 10000);
  return { subtotal, discount, tax, total: subtotal - discount + tax };
}

function randomOrder(rng: Rng): PricedOrder {
  const lines = Array.from({ length: rng.int(1, 4) }, () => ({
    sku: `SKU-${rng.int(1000, 9999)}`,
    qty: rng.int(1, 12),
    unitCents: rng.int(49, 25_000),
  }));
  return {
    lines,
    discountBps: rng.pick([0, 0, 0, 500, 1000, 1250, 1500, 2000, 2500]),
    taxBps: rng.pick([0, 700, 1900, 2000, 2100, 2500]),
  };
}

function pricingFixCase(): DeciderCase {
  const rng = new Rng(0x9a1c);
  const named: [string, PricedOrder][] = [
    [
      'half cent discount rounds to even (down)',
      { lines: [{ sku: 'SKU-1001', qty: 1, unitCents: 125 }], discountBps: 1000, taxBps: 0 },
    ],
    [
      'half cent discount rounds to even (up)',
      { lines: [{ sku: 'SKU-1002', qty: 1, unitCents: 135 }], discountBps: 1000, taxBps: 0 },
    ],
    [
      'half cent tax rounds to even (down)',
      { lines: [{ sku: 'SKU-1003', qty: 3, unitCents: 50 }], discountBps: 0, taxBps: 1900 },
    ],
    [
      'half cent tax rounds to even (up)',
      { lines: [{ sku: 'SKU-1004', qty: 5, unitCents: 50 }], discountBps: 0, taxBps: 1900 },
    ],
    [
      'tax is charged on the discounted amount',
      { lines: [{ sku: 'SKU-1005', qty: 2, unitCents: 5000 }], discountBps: 2000, taxBps: 2000 },
    ],
    [
      'no discount, no tax',
      { lines: [{ sku: 'SKU-1006', qty: 4, unitCents: 999 }], discountBps: 0, taxBps: 0 },
    ],
  ];
  while (named.length < 24) {
    const order = randomOrder(rng);
    named.push([
      `${order.lines.length} line(s), discount ${order.discountBps}bps, tax ${order.taxBps}bps`,
      order,
    ]);
  }
  const cases = named.map(([name, order]) => ({ name, order, expected: priceCorrect(order) }));
  const casesJson = `[\n${cases.map(c => `  ${JSON.stringify(c)}`).join(',\n')}\n]\n`;
  const runLines: string[] = [];
  let pass = 0;
  cases.forEach((c, i) => {
    const got = priceBuggy(c.order);
    const diff = (['subtotal', 'discount', 'tax', 'total'] as const).filter(
      k => got[k] !== c.expected[k]
    );
    if (diff.length === 0) {
      pass++;
      runLines.push(`ok ${i + 1} - ${c.name}`);
      return;
    }
    runLines.push(`not ok ${i + 1} - ${c.name}`);
    for (const k of diff) runLines.push(`    ${k}: expected ${c.expected[k]}, got ${got[k]}`);
  });
  runLines.push(`# tests ${cases.length}`, `# pass ${pass}`, `# fail ${cases.length - pass}`);

  const orders: string[] = [];
  for (let i = 0; i < 240; i++) {
    const order = randomOrder(rng);
    orders.push(
      JSON.stringify({ id: `ORD-${10231 + i}`, customer: `c_${pad(rng.int(1, 400), 4)}`, ...order })
    );
  }
  const ordersJsonl = joinLines(orders);
  const files = {
    'package.json': json2({
      name: 'quote-engine',
      private: true,
      scripts: { test: 'node test/run.js', 'build:quotes': 'node scripts/build-quotes.js' },
    }),
    'src/pricing.js': PRICING_JS,
    'test/run.js': PRICING_RUN_JS,
    'test/pricing.cases.json': casesJson,
    'scripts/build-quotes.js': BUILD_QUOTES_JS,
    'data/orders.jsonl': ordersJsonl,
  };

  return {
    id: 'cont-agent-multi-pricing-fix',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt: [
      'The pricing tests in this repo fail and sales needs a fresh out/quotes.csv. Fix the pricing code, then rebuild the quotes.',
      '',
      'Pricing rules (all amounts are integer cents, rates are basis points):',
      '- subtotal = sum of qty * unitCents over the order lines',
      "- discount = subtotal * discountBps / 10000, rounded to a whole cent with round-half-to-even (banker's rounding) on the exact value",
      '- tax = (subtotal - discount) * taxBps / 10000, rounded the same way (tax is charged on the discounted amount)',
      '- total = subtotal - discount + tax',
      '',
      'Steps:',
      '1. Read src/pricing.js and run the tests with `node test/run.js`.',
      '2. Read the test cases, scripts/build-quotes.js and data/orders.jsonl.',
      '3. Fix src/pricing.js so it follows the rules above exactly (use integer arithmetic for the rounding; keep the exported API).',
      '4. Run `node test/run.js` again until every test passes.',
      '5. Run `node scripts/build-quotes.js` to write out/quotes.csv.',
      '6. Compute the SHA-256 of out/quotes.csv.',
      '',
      'Final answer: compact JSON with exactly these keys in this order: {"passed":<passing tests in the last run>,"failed":<failing tests in the last run>,"orders":<data rows in out/quotes.csv>,"sha256":"<lowercase hex SHA-256 of out/quotes.csv>"}',
    ].join('\n'),
    requiredToolCalls: 1,
    continuation: {
      files,
      steps: [
        {
          text: "I'll read the pricing code and run the tests to see what fails.",
          calls: [
            bash(
              'cat src/pricing.js test/run.js',
              'Show pricing code and test runner',
              PRICING_JS + PRICING_RUN_JS
            ),
            bash('node test/run.js', 'Run the pricing tests', joinLines(runLines)),
          ],
        },
        {
          text: 'Now the test cases, the quote builder and the order data.',
          calls: [
            bash('cat test/pricing.cases.json', 'Show the pricing test cases', casesJson),
            bash('cat scripts/build-quotes.js', 'Show the quote builder', BUILD_QUOTES_JS),
            bash('cat data/orders.jsonl', 'Show the orders', ordersJsonl),
          ],
        },
      ],
      message: RESUME,
    },
    check: {
      kind: 'json_equal',
      value: {
        passed: 24,
        failed: 0,
        orders: 240,
        sha256: '113e9eb304f3a66a037f32575d5b9cc177094ef2e774776ebb21f9750a85e048',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// multi_step_execution: migrate user fixtures to the v2 schema (about 25k tokens)

const GIVEN_NAMES = [
  'Ada',
  'Grace',
  'Alan',
  'Linus',
  'Margaret',
  'Edsger',
  'Barbara',
  'Ken',
  'Radia',
  'Donald',
  'Frances',
  'Tim',
  'Sophie',
  'Yukihiro',
  'Hedy',
  'Dennis',
  'Annie',
  'Guido',
  'Karen',
  'Niklaus',
  'Joan',
  'Bjarne',
  'Shafi',
  'Leslie',
];
const FAMILY_NAMES = [
  'Lovelace',
  'Hopper',
  'Turing',
  'Torvalds',
  'Hamilton',
  'Dijkstra',
  'Liskov',
  'Thompson',
  'Perlman',
  'Knuth',
  'Allen',
  'Berners-Lee',
  'Wilson',
  'Matsumoto',
  'Lamarr',
  'Ritchie',
  'Easley',
  'van Rossum',
  'Sparck Jones',
  'Wirth',
  'Clarke',
  'Stroustrup',
  'Goldwasser',
  'de la Cruz',
];
const USER_DOMAINS = ['example.com', 'mail.example.org', 'corp.example.net', 'example.io'];
const USER_ROLES = ['admin', 'billing', 'editor', 'owner', 'support', 'viewer'];
const USER_TZS = [
  'Europe/Berlin',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Tokyo',
  'Australia/Sydney',
  'UTC',
];

const USER_V2_DOC = joinLines([
  '# User records, schema v2',
  '',
  'v2 replaces the loosely typed v1 export. One JSON object per line (JSONL), LF line endings,',
  'a final newline, no blank lines. Records keep the v1 order. Keys appear in exactly this order:',
  '',
  '| key | type | from v1 |',
  '| --- | --- | --- |',
  '| id | string | "usr_" + the v1 numeric id zero-padded to 6 digits (17 -> "usr_000017") |',
  '| givenName | string | v1 name trimmed, up to the first space |',
  '| familyName | string | the rest of the trimmed v1 name after the first space ("" when there is none) |',
  '| email | string | v1 email trimmed and lowercased |',
  '| createdAt | string | v1 created "YYYY-MM-DD HH:MM:SS" (UTC) as "YYYY-MM-DDTHH:MM:SSZ" |',
  '| roles | string[] | v1 roles split on ",", each trimmed, empty entries dropped, duplicates removed, sorted in code-unit order |',
  '| active | boolean | v1 active "yes" -> true, "no" -> false |',
  '| timezone | string | v1 prefs.tz |',
  '| newsletter | boolean | v1 prefs.newsletter 1 -> true, 0 -> false |',
  '',
  'Serialize each record with JSON.stringify (no spaces).',
  '',
  'Validation: `node scripts/validate-v2.js <file>` checks key order and value formats only;',
  'it cannot tell whether a value was derived correctly, so follow the table exactly.',
]);

const VALIDATE_V2_JS = joinLines([
  "'use strict';",
  '// Validates a v2 users JSONL file. Usage: node scripts/validate-v2.js <file>',
  "const fs = require('fs');",
  '',
  "const KEYS = ['id', 'givenName', 'familyName', 'email', 'createdAt', 'roles', 'active', 'timezone', 'newsletter'];",
  '',
  'function firstError(record) {',
  "  const keys = Object.keys(record).join(',');",
  "  if (keys !== KEYS.join(',')) return 'keys must be ' + KEYS.join(',') + ' (got ' + keys + ')';",
  "  if (!/^usr_\\d{6}$/.test(record.id)) return 'bad id ' + JSON.stringify(record.id);",
  "  if (typeof record.givenName !== 'string' || record.givenName === '') return 'givenName must be a non-empty string';",
  "  if (typeof record.familyName !== 'string') return 'familyName must be a string';",
  "  if (!/^[^\\sA-Z@]+@[^\\sA-Z@]+$/.test(record.email)) return 'bad email ' + JSON.stringify(record.email);",
  "  if (!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$/.test(record.createdAt)) return 'bad createdAt ' + JSON.stringify(record.createdAt);",
  "  if (!Array.isArray(record.roles) || record.roles.some(r => typeof r !== 'string' || r === '' || r !== r.trim())) return 'bad roles';",
  "  if (record.roles.join(',') !== [...new Set(record.roles)].sort().join(',')) return 'roles must be unique and sorted';",
  "  if (typeof record.active !== 'boolean') return 'active must be a boolean';",
  "  if (typeof record.timezone !== 'string' || record.timezone === '') return 'timezone must be a non-empty string';",
  "  if (typeof record.newsletter !== 'boolean') return 'newsletter must be a boolean';",
  '  return null;',
  '}',
  '',
  'const file = process.argv[2];',
  "const text = fs.readFileSync(file, 'utf8');",
  "if (!text.endsWith('\\n')) console.log('file must end with a newline');",
  "const lines = text.split('\\n').slice(0, -1);",
  'let valid = 0;',
  'let shown = 0;',
  'lines.forEach((line, i) => {',
  '  let error;',
  '  try {',
  '    error = firstError(JSON.parse(line));',
  '  } catch (e) {',
  "    error = 'not JSON: ' + e.message;",
  '  }',
  '  if (error === null) valid++;',
  "  else if (shown++ < 40) console.log('line ' + (i + 1) + ': ' + error);",
  '});',
  "if (shown > 40) console.log('... and ' + (shown - 40) + ' more invalid line(s)');",
  "console.log('valid ' + valid + '/' + lines.length);",
  'process.exitCode = valid === lines.length ? 0 : 1;',
]);

function userMigrationCase(): DeciderCase {
  const rng = new Rng(0x05e7);
  const records: string[] = [];
  let id = 1000;
  for (let i = 0; i < 400; i++) {
    id += rng.int(1, 37);
    const given = rng.pick(GIVEN_NAMES);
    const family = rng.chance(0.06) ? '' : rng.pick(FAMILY_NAMES);
    let name = family ? `${given} ${family}` : given;
    if (rng.chance(0.08)) name = ` ${name}`;
    if (rng.chance(0.06)) name = `${name} `;
    const local = `${given}.${family.replace(/ /g, '')}`.replace(/\.$/, '');
    let email = `${rng.chance(0.3) ? local.toUpperCase() : rng.chance(0.5) ? local : local.toLowerCase()}@${rng.pick(USER_DOMAINS)}`;
    if (rng.chance(0.1)) email = rng.chance(0.5) ? ` ${email}` : `${email} `;
    if (rng.chance(0.15)) email = email.replace(/@.*/, m => m.toUpperCase());
    const created = `20${rng.int(21, 25)}-${pad(rng.int(1, 12), 2)}-${pad(rng.int(1, 28), 2)} ${pad(rng.int(0, 23), 2)}:${pad(rng.int(0, 59), 2)}:${pad(rng.int(0, 59), 2)}`;
    const roleParts = Array.from({ length: rng.int(1, 3) }, () => rng.pick(USER_ROLES));
    if (rng.chance(0.15)) roleParts.push(roleParts[0]);
    if (rng.chance(0.1)) roleParts.splice(1, 0, '');
    const roles = roleParts.map(r => (rng.chance(0.12) ? ` ${r}` : r)).join(',');
    records.push(
      JSON.stringify({
        id,
        name,
        email,
        created,
        roles,
        active: rng.chance(0.8) ? 'yes' : 'no',
        prefs: { tz: rng.pick(USER_TZS), newsletter: rng.chance(0.4) ? 1 : 0 },
      })
    );
  }
  const v1 = joinLines(records);
  const validateLines = records
    .slice(0, 40)
    .map(
      (_, i) =>
        `line ${i + 1}: keys must be id,givenName,familyName,email,createdAt,roles,active,timezone,newsletter (got id,name,email,created,roles,active,prefs)`
    );
  validateLines.push(
    `... and ${records.length - 40} more invalid line(s)`,
    `valid 0/${records.length}`
  );
  const files = {
    'docs/user-v2.md': USER_V2_DOC,
    'fixtures/users-v1.jsonl': v1,
    'scripts/validate-v2.js': VALIDATE_V2_JS,
    'package.json': json2({ name: 'user-fixtures', private: true, type: 'commonjs' }),
  };

  return {
    id: 'cont-agent-multi-user-migration',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt: [
      'Our integration tests are moving to the v2 user schema. Convert the v1 fixture file to v2.',
      '',
      'Steps:',
      '1. Read the v2 spec in docs/user-v2.md.',
      '2. Inspect fixtures/users-v1.jsonl.',
      '3. Read scripts/validate-v2.js and run it on the v1 file to see what it checks.',
      '4. Write scripts/migrate.js that reads fixtures/users-v1.jsonl and writes fixtures/users-v2.jsonl following docs/user-v2.md exactly.',
      '5. Run it, then run `node scripts/validate-v2.js fixtures/users-v2.jsonl`; every line must be valid.',
      '6. Compute the SHA-256 of fixtures/users-v2.jsonl.',
      '',
      'Final answer: compact JSON with exactly these keys in this order: {"records":<lines in fixtures/users-v2.jsonl>,"valid":<valid count reported by the validator>,"activeAdmins":<records with active true whose roles include "admin">,"sha256":"<lowercase hex SHA-256 of fixtures/users-v2.jsonl>"}',
    ].join('\n'),
    requiredToolCalls: 1,
    continuation: {
      files,
      steps: [
        {
          text: "I'll read the v2 spec and look at the fixture file.",
          calls: [
            bash('cat docs/user-v2.md', 'Show the v2 spec', USER_V2_DOC),
            bash('wc -l < fixtures/users-v1.jsonl', 'Count v1 records', `${records.length}\n`),
            bash(
              "sed -n '1,200p' fixtures/users-v1.jsonl",
              'Show the first 200 v1 records',
              sedRange(v1, 1, 200)
            ),
          ],
        },
        {
          text: 'Now the validator, and what it says about the v1 file.',
          calls: [
            bash('cat scripts/validate-v2.js', 'Show the validator', VALIDATE_V2_JS),
            bash(
              'node scripts/validate-v2.js fixtures/users-v1.jsonl',
              'Validate the v1 file against v2',
              joinLines(validateLines)
            ),
            bash(
              "sed -n '201,400p' fixtures/users-v1.jsonl",
              'Show the remaining v1 records',
              sedRange(v1, 201, 400)
            ),
          ],
        },
      ],
      message: RESUME,
    },
    check: {
      kind: 'json_equal',
      value: {
        records: 400,
        valid: 400,
        activeAdmins: 98,
        sha256: 'a15b54927f3b96f274ee8a17caa9ba880c1fbb37ac3e675a14412938f4b5dd03',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// multi_step_execution: fix the ETL dedupe and day bucketing, rerun, check (about 40k tokens)

const ETL_RUN_SH = joinLines([
  '#!/usr/bin/env bash',
  '# Runs extract -> transform -> load and writes out/daily.csv.',
  'set -euo pipefail',
  'cd "$(dirname "$0")/.."',
  'mkdir -p out',
  'node etl/main.js',
]);

const ETL_MAIN_JS = joinLines([
  "'use strict';",
  "const { extract } = require('./extract');",
  "const { transform } = require('./transform');",
  "const { load } = require('./load');",
  '',
  'const { events } = extract();',
  'const rows = load(transform(events));',
  "console.log('wrote out/daily.csv (' + rows + ' rows)');",
]);

const ETL_EXTRACT_JS = joinLines([
  "'use strict';",
  '// Reads raw/*.ndjson in file name order, one event per line.',
  "const fs = require('fs');",
  "const path = require('path');",
  '',
  "const RAW = path.join(__dirname, '..', 'raw');",
  '',
  'function extract() {',
  "  const files = fs.readdirSync(RAW).filter(f => f.endsWith('.ndjson')).sort();",
  '  const events = [];',
  '  const stats = [];',
  '  for (const file of files) {',
  "    const lines = fs.readFileSync(path.join(RAW, file), 'utf8').split('\\n').filter(l => l.trim() !== '');",
  '    for (const line of lines) events.push(JSON.parse(line));',
  '    stats.push({ file, events: lines.length });',
  '  }',
  '  return { events, stats };',
  '}',
  '',
  'module.exports = { extract };',
  '',
  "if (require.main === module && process.argv.includes('--stats')) {",
  '  const { events, stats } = extract();',
  "  for (const s of stats) console.log(s.file + ': ' + s.events + ' events');",
  "  console.log('total: ' + events.length + ' events');",
  '}',
]);

const ETL_TRANSFORM_JS = joinLines([
  "'use strict';",
  '// Dedupes webhook redeliveries and assigns every event to a reporting day.',
  '',
  'function transform(events) {',
  '  const seen = new Set();',
  '  const out = [];',
  '  for (const e of events) {',
  '    if (seen.has(e.event_id)) continue; // first delivery wins',
  '    seen.add(e.event_id);',
  '    out.push({ date: e.ts.slice(0, 10), account: e.account, type: e.type, amount_minor: e.amount_minor });',
  '  }',
  '  return out;',
  '}',
  '',
  'module.exports = { transform };',
  '',
  "if (require.main === module && process.argv.includes('--dupes')) {",
  "  const { events } = require('./extract').extract();",
  '  const groups = new Map();',
  '  for (const e of events) {',
  '    const list = groups.get(e.event_id);',
  '    if (list) list.push(e);',
  '    else groups.set(e.event_id, [e]);',
  '  }',
  '  let ids = 0;',
  '  let extra = 0;',
  '  for (const [id, list] of groups) {',
  '    if (list.length < 2) continue;',
  '    ids++;',
  '    extra += list.length - 1;',
  "    console.log(id + ' deliveries=' + list.length + ' seqs=' + list.map(e => e.seq).join(',') + ' amounts=' + list.map(e => e.amount_minor).join(','));",
  '  }',
  "  console.log(ids + ' duplicated event ids, ' + extra + ' redundant deliveries (dry run, nothing written)');",
  '}',
]);

const ETL_LOAD_JS = joinLines([
  "'use strict';",
  '// Aggregates transformed events per (date, account, type) into out/daily.csv.',
  "const fs = require('fs');",
  "const path = require('path');",
  '',
  'function load(rows) {',
  '  const groups = new Map();',
  '  for (const r of rows) {',
  "    const key = r.date + ',' + r.account + ',' + r.type;",
  '    const g = groups.get(key) ?? { date: r.date, account: r.account, type: r.type, events: 0, amount: 0 };',
  '    g.events += 1;',
  '    g.amount += r.amount_minor;',
  '    groups.set(key, g);',
  '  }',
  '  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);',
  '  const sorted = [...groups.values()].sort((a, b) => cmp(a.date, b.date) || cmp(a.account, b.account) || cmp(a.type, b.type));',
  "  const lines = ['date,account,type,events,amount_minor'];",
  "  for (const g of sorted) lines.push([g.date, g.account, g.type, g.events, g.amount].join(','));",
  "  fs.writeFileSync(path.join(__dirname, '..', 'out', 'daily.csv'), lines.join('\\n') + '\\n');",
  '  return sorted.length;',
  '}',
  '',
  'module.exports = { load };',
]);

const ETL_CHECK_JS = joinLines([
  "'use strict';",
  '// Sanity checks out/daily.csv before it is uploaded.',
  "const fs = require('fs');",
  "const path = require('path');",
  '',
  "const lines = fs.readFileSync(path.join(__dirname, '..', 'out', 'daily.csv'), 'utf8').split('\\n');",
  "if (lines.pop() !== '') throw new Error('missing final newline');",
  "if (lines.shift() !== 'date,account,type,events,amount_minor') throw new Error('bad header');",
  'let previous = null;',
  'let events = 0;',
  'let amount = 0;',
  'for (const line of lines) {',
  "  const [date, account, type, count, sum] = line.split(',');",
  "  if (!/^2026-11-\\d{2}$/.test(date)) throw new Error('bad date: ' + line);",
  "  const key = [date, account, type].join(',');",
  "  if (previous !== null && key <= previous) throw new Error('rows not sorted or duplicated: ' + line);",
  '  previous = key;',
  "  if (!/^\\d+$/.test(count) || !/^-?\\d+$/.test(sum)) throw new Error('bad numbers: ' + line);",
  '  events += Number(count);',
  '  amount += Number(sum);',
  '}',
  "console.log('check: OK rows=' + lines.length + ' events=' + events + ' amount_minor=' + amount);",
]);

type EtlEvent = {
  event_id: string;
  seq: number;
  account: string;
  type: string;
  amount_minor: number;
  currency: string;
  ts: string;
  source: string;
};

const ETL_OFFSETS = [0, 60, 60, 60, -300, -480, 330, 540, 120];
const ETL_TYPES = [
  { type: 'invoice.paid', weight: 50, source: 'billing-webhook' },
  { type: 'invoice.refunded', weight: 6, source: 'billing-webhook' },
  { type: 'subscription.renewed', weight: 30, source: 'subscriptions' },
  { type: 'payout.sent', weight: 14, source: 'payouts' },
];

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`;
}

function localTs(utcSeconds: number, offsetMinutes: number): string {
  const local = utcSeconds + offsetMinutes * 60;
  const day = Math.floor(local / 86400);
  const secs = local - day * 86400;
  // Day 0 is 2026-11-01; every event falls within November.
  const date = `2026-11-${pad(day + 1, 2)}`;
  return `${date}T${pad(Math.floor(secs / 3600), 2)}:${pad(Math.floor(secs / 60) % 60, 2)}:${pad(secs % 60, 2)}${formatOffset(offsetMinutes)}`;
}

function etlEvents(): { files: Record<string, string>; byFile: EtlEvent[][] } {
  const rng = new Rng(0xe71);
  let counter = 0;
  const pool: EtlEvent[] = [];
  const byFile: EtlEvent[][] = [];
  const files: Record<string, string> = {};
  for (const dayOfMonth of [17, 18, 19]) {
    const events: EtlEvent[] = [];
    let utc = (dayOfMonth - 1) * 86400 + rng.int(0, 60);
    for (let i = 0; i < 1080; i++) {
      utc += rng.int(30, 130);
      if (pool.length > 50 && rng.chance(0.06)) {
        const original = pool[pool.length - 1 - rng.int(0, Math.min(pool.length - 1, 400))];
        const roll = rng.float();
        if (roll < 0.55) {
          const corrected = {
            ...original,
            seq: original.seq + 1,
            amount_minor: original.amount_minor + rng.int(-500, 500) * 10,
          };
          pool.push(corrected);
          events.push(corrected);
        } else if (roll < 0.8 || original.seq === 1) {
          events.push({ ...original });
        } else {
          events.push({
            ...original,
            seq: original.seq - 1,
            amount_minor: original.amount_minor - 1000,
          });
        }
        continue;
      }
      counter++;
      const kind = rng.weighted(ETL_TYPES);
      const id = `evt_${((counter * 2654435761) >>> 0).toString(16).padStart(8, '0')}`;
      const event: EtlEvent = {
        event_id: id,
        seq: 1,
        account: `acct_${pad(rng.int(1, 60), 3)}`,
        type: kind.type,
        amount_minor:
          kind.type === 'payout.sent' ? rng.int(10_000, 2_000_000) : rng.int(500, 250_000),
        currency: 'EUR',
        ts: localTs(utc - rng.int(0, 900), rng.pick(ETL_OFFSETS)),
        source: kind.source,
      };
      pool.push(event);
      events.push(event);
    }
    byFile.push(events);
    files[`raw/events-2026-11-${dayOfMonth}.ndjson`] = joinLines(
      events.map(e => JSON.stringify(e))
    );
  }
  return { files, byFile };
}

function etlDedupeCase(): DeciderCase {
  const { files: rawFiles, byFile } = etlEvents();
  const files: Record<string, string> = {
    ...rawFiles,
    'etl/run.sh': ETL_RUN_SH,
    'etl/main.js': ETL_MAIN_JS,
    'etl/extract.js': ETL_EXTRACT_JS,
    'etl/transform.js': ETL_TRANSFORM_JS,
    'etl/load.js': ETL_LOAD_JS,
    'etl/check.js': ETL_CHECK_JS,
  };
  const rawNames = Object.keys(rawFiles).sort(byCodeUnit);
  const stats = [
    ...rawNames.map((name, i) => `${name.slice('raw/'.length)}: ${byFile[i].length} events`),
    `total: ${byFile.reduce((sum, list) => sum + list.length, 0)} events`,
  ];
  const groups = new Map<string, EtlEvent[]>();
  for (const e of byFile.flat()) {
    const list = groups.get(e.event_id);
    if (list) list.push(e);
    else groups.set(e.event_id, [e]);
  }
  const dupes: string[] = [];
  let ids = 0;
  let extra = 0;
  for (const [id, list] of groups) {
    if (list.length < 2) continue;
    ids++;
    extra += list.length - 1;
    dupes.push(
      `${id} deliveries=${list.length} seqs=${list.map(e => e.seq).join(',')} amounts=${list.map(e => e.amount_minor).join(',')}`
    );
  }
  dupes.push(
    `${ids} duplicated event ids, ${extra} redundant deliveries (dry run, nothing written)`
  );
  const day17 = rawFiles['raw/events-2026-11-17.ndjson'];
  const nearMidnight = linesOf(day17)
    .filter(line => /T(2[2-3]|0[0-1]):/.test(line))
    .slice(0, 280);

  return {
    id: 'cont-agent-multi-etl-dedupe',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt: [
      'The daily revenue export (out/daily.csv) double counts webhook redeliveries and puts late-evening events on the wrong day. Fix the ETL and regenerate the export.',
      '',
      'Correct behaviour:',
      '- Events are deduplicated by event_id. For each event_id keep only the delivery with the highest seq; when several deliveries share the highest seq, keep the one read last (files are read in name order, lines in file order).',
      '- An event belongs to the UTC calendar date of its ts (ts carries a UTC offset, e.g. 2026-11-17T23:41:07-05:00 is 2026-11-18 in UTC).',
      '- out/daily.csv keeps its current format and sorting (etl/load.js is correct).',
      '',
      'Steps:',
      '1. Read etl/run.sh, etl/main.js and etl/transform.js.',
      '2. Run `node etl/extract.js --stats` and `node etl/transform.js --dry-run --dupes` to see the input volume and the redeliveries.',
      '3. Look at the raw events, especially around midnight.',
      '4. Fix etl/transform.js (keep its exported transform(events) API and its --dupes report).',
      '5. Run `bash etl/run.sh`, then `node etl/check.js`, which must print a "check: OK" line.',
      '6. Compute the SHA-256 of out/daily.csv.',
      '',
      'Final answer: compact JSON with exactly these keys in this order: {"rows":<rows from the check line>,"events":<events from the check line>,"amountMinor":<amount_minor from the check line>,"sha256":"<lowercase hex SHA-256 of out/daily.csv>"}',
    ].join('\n'),
    requiredToolCalls: 1,
    continuation: {
      files,
      steps: [
        {
          text: "I'll read the pipeline entry points and the transform step first.",
          calls: [
            bash(
              'cat etl/run.sh etl/main.js etl/transform.js',
              'Show the pipeline and transform code',
              ETL_RUN_SH + ETL_MAIN_JS + ETL_TRANSFORM_JS
            ),
            bash('node etl/extract.js --stats', 'Count raw events per file', joinLines(stats)),
            bash(
              'node etl/transform.js --dry-run --dupes',
              'List redelivered events',
              joinLines(dupes)
            ),
          ],
        },
        {
          text: 'Now the raw events, including the ones near midnight where the offsets matter.',
          calls: [
            bash(
              "sed -n '1,280p' raw/events-2026-11-18.ndjson",
              'Show the first 280 events of the 18th',
              sedRange(rawFiles['raw/events-2026-11-18.ndjson'], 1, 280)
            ),
            bash(
              "grep -hE 'T(2[2-3]|0[0-1]):' raw/events-2026-11-17.ndjson | head -n 280",
              'Show events near midnight on the 17th',
              joinLines(nearMidnight)
            ),
            bash(
              'tail -n 260 raw/events-2026-11-19.ndjson',
              'Show the last events of the 19th',
              tailLines(rawFiles['raw/events-2026-11-19.ndjson'], 260)
            ),
          ],
        },
      ],
      message: RESUME,
    },
    check: {
      kind: 'json_equal',
      value: {
        rows: 649,
        events: 3022,
        amountMinor: 765516315,
        sha256: 'f6bd7439f89417dd7c73b44dcb1116d80e65164651a3c9366737f40774e74b12',
      },
    },
  };
}

export const CONTINUATION_CASES: readonly DeciderCase[] = [
  invoiceRollupCase(),
  accessLatencyCase(),
  i18nSyncCase(),
  envRolloutCase(),
  logSplitCase(),
  migrationRenumberCase(),
  pricingFixCase(),
  userMigrationCase(),
  etlDedupeCase(),
];
