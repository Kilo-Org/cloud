/* eslint-disable import/no-nodejs-modules, max-lines, promise/avoid-new, typescript-eslint/no-unsafe-argument, typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access, typescript-eslint/no-unsafe-return, typescript-eslint/strict-boolean-expressions -- One self-contained stdio MCP client, renderer and diff for the generated contract. */
// Vendors the Playwright MCP tool contract into src/shared/browser-tool-contract.ts.
// Prefers an installed `playwright-mcp` binary at the pinned version.
// Falls back to `npx -y @playwright/mcp@<pin>`; the pin never enters package.json.
// Write: node apps/extension/scripts/generate-browser-tool-contract.mjs
// Check: node apps/extension/scripts/generate-browser-tool-contract.mjs --check
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const UPSTREAM_PLAYWRIGHT_MCP_VERSION = '0.0.81';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const MCP_PACKAGE_NAME = '@playwright/mcp';
const MCP_SERVER_ARGS = ['--headless'];
const REQUEST_TIMEOUT_MS = 120_000;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = resolvePath(SCRIPT_DIR, '..');
const REPO_ROOT = resolvePath(EXTENSION_DIR, '../..');
const OUTPUT_PATH = join(EXTENSION_DIR, 'src/shared/browser-tool-contract.ts');
const OUTPUT_LABEL = 'apps/extension/src/shared/browser-tool-contract.ts';
const GENERATION_COMMAND = 'node apps/extension/scripts/generate-browser-tool-contract.mjs';

// Uses an installed binary only when it is the pinned @playwright/mcp.
// Other versions would vendor a different contract under the pinned header.
const findInstalledServer = async () => {
  const candidates = [
    join(EXTENSION_DIR, 'node_modules/.bin/playwright-mcp'),
    join(REPO_ROOT, 'node_modules/.bin/playwright-mcp'),
  ];

  const manifests = await Promise.all(
    candidates.map(async candidate => {
      try {
        await access(candidate, constants.X_OK);
        const manifestPath = join(dirname(await realpath(candidate)), 'package.json');

        return JSON.parse(await readFile(manifestPath, 'utf8'));
      } catch {
        return null;
      }
    })
  );

  const installedIndex = manifests.findIndex(
    manifest =>
      manifest?.name === MCP_PACKAGE_NAME && manifest?.version === UPSTREAM_PLAYWRIGHT_MCP_VERSION
  );
  const installed = candidates[installedIndex];

  if (installed !== undefined) {
    return { args: MCP_SERVER_ARGS, command: installed, source: installed };
  }

  const pin = `${MCP_PACKAGE_NAME}@${UPSTREAM_PLAYWRIGHT_MCP_VERSION}`;

  return { args: ['-y', pin, ...MCP_SERVER_ARGS], command: 'npx', source: `npx -y ${pin}` };
};

const readToolsList = async () => {
  const { args, command, source } = await findInstalledServer();
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const failures = [];
  let buffer = '';
  let stderr = '';

  const rejectAll = reason => {
    for (const { reject } of pending.values()) {
      reject(reason);
    }
    pending.clear();
  };

  const handleLine = line => {
    let message = null;

    try {
      message = JSON.parse(line);
    } catch (error) {
      failures.push(`Cannot parse a ${source} message: ${error.message}\n${line}`);
    }

    if (message !== null) {
      const settle = pending.get(message.id);

      if (settle !== undefined) {
        pending.delete(message.id);
        settle.resolve(message);
      }
    }
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  child.on('error', error => {
    rejectAll(new Error(`Cannot start ${source}: ${error.message}`));
  });
  child.on('exit', code => {
    rejectAll(new Error(`${source} exited with code ${code}\n${stderr}`));
  });
  child.stdout.on('data', chunk => {
    buffer += chunk;

    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);

      if (line !== '') {
        handleLine(line);
      }

      newline = buffer.indexOf('\n');
    }
  });

  const send = message => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      pending.set(id, { reject, resolve });
      send({ id, jsonrpc: '2.0', method, params });
    });

  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
    rejectAll(new Error(`Timed out after ${REQUEST_TIMEOUT_MS}ms waiting for ${source}`));
  }, REQUEST_TIMEOUT_MS);

  try {
    const initialize = await request(1, 'initialize', {
      capabilities: {},
      clientInfo: { name: 'kilo-extension-browser-tool-contract', version: '1.0.0' },
      protocolVersion: MCP_PROTOCOL_VERSION,
    });

    if (initialize.error) {
      throw new Error(`${source} rejected initialize: ${JSON.stringify(initialize.error)}`);
    }

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const listed = await request(2, 'tools/list', {});

    if (listed.error) {
      throw new Error(`${source} rejected tools/list: ${JSON.stringify(listed.error)}`);
    }

    if (failures.length > 0) {
      throw new Error(failures.join('\n'));
    }

    const { result } = listed;

    if (!result || !Array.isArray(result.tools) || result.tools.length === 0) {
      throw new Error(`${source} returned an empty tools/list result: ${JSON.stringify(listed)}`);
    }

    return { result, source };
  } finally {
    clearTimeout(timeout);
    child.kill('SIGTERM');
  }
};

const toContractEntry = tool => {
  const { annotations, description, inputSchema, name } = tool;

  if (!name || !inputSchema || inputSchema.type !== 'object') {
    throw new Error(`Unexpected tools/list entry: ${JSON.stringify(tool)}`);
  }

  return {
    description: description ?? '',
    inputSchema,
    name,
    readOnly: annotations?.readOnlyHint === true,
    title: annotations?.title ?? '',
  };
};

const renderContract = ({ result, sha256 }) => {
  const entries = result.tools.map(toContractEntry);
  const data = JSON.stringify(entries, null, 2);

  return `/* eslint-disable max-lines, sort-keys, typescript-eslint/consistent-type-definitions, unicorn/numeric-separators-style -- Upstream tools/list output is vendored verbatim */
// Generated by ${GENERATION_COMMAND}. Do not edit by hand.
//
// Upstream: @playwright/mcp ${UPSTREAM_PLAYWRIGHT_MCP_VERSION} (pin: ${MCP_PACKAGE_NAME}@${UPSTREAM_PLAYWRIGHT_MCP_VERSION})
// Generation command: ${GENERATION_COMMAND}
// Raw tools/list JSON SHA-256: ${sha256}
//
// The upstream contract is emitted verbatim: tool order, schema key order and
// Literals come from \`tools/list\` and must not be reordered or reformatted.
// The only rename is the model-facing tool name prefix \`playwright_\` -> \`kilo_\`.
// Re-run the generation command after changing the pin; \`--check\` fails on drift.

export type BrowserToolInputSchema = {
  $schema: string;
  type: 'object';
  properties: Record<string, unknown>;
  required?: readonly string[];
  additionalProperties: boolean;
};

export type BrowserToolContractEntry = {
  name: string;
  title: string;
  description: string;
  inputSchema: BrowserToolInputSchema;
  readOnly: boolean;
};

export const UPSTREAM_PLAYWRIGHT_MCP_VERSION = '${UPSTREAM_PLAYWRIGHT_MCP_VERSION}';

export const BROWSER_TOOL_CONTRACT: readonly BrowserToolContractEntry[] = ${data};

export const KILO_BROWSER_TOOL_PREFIX = 'kilo_';

export type KiloBrowserToolName = \`kilo_browser_\${string}\`;

export const toKiloBrowserToolName = (name: string): string =>
  \`\${KILO_BROWSER_TOOL_PREFIX}\${name}\`;

export const KILO_BROWSER_TOOL_NAMES: readonly string[] = BROWSER_TOOL_CONTRACT.map(entry =>
  toKiloBrowserToolName(entry.name)
);

export const SAFE_BROWSER_TOOL_NAMES: readonly string[] = BROWSER_TOOL_CONTRACT.filter(
  entry => entry.readOnly
).map(entry => entry.name);

export const isSafeBrowserToolName = (name: string): boolean =>
  SAFE_BROWSER_TOOL_NAMES.includes(name);
`;
};

// The committed file must survive `pnpm format` unchanged.
// The generator therefore runs the repository formatter before write and check.
const formatTypeScript = text => {
  try {
    return execFileSync(
      'pnpm',
      ['-w', 'exec', 'oxfmt', '--ignore-path', '/dev/null', '--stdin-filepath', OUTPUT_PATH],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        input: text,
        maxBuffer: 64 * 1024 * 1024,
      }
    );
  } catch (error) {
    throw new Error(`oxfmt could not format the generated contract: ${error.message}`, {
      cause: error,
    });
  }
};

// Minimal line-based unified diff with three lines of context.
// A single hunk around the changed region describes any drift, because the
// Generated output shares a long common prefix and suffix with the committed file.
const buildUnifiedDiff = ({ from, fromLabel, to, toLabel }) => {
  const context = 3;
  const fromLines = from.split('\n');
  const toLines = to.split('\n');

  let prefix = 0;
  while (
    prefix < fromLines.length &&
    prefix < toLines.length &&
    fromLines[prefix] === toLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < fromLines.length - prefix &&
    suffix < toLines.length - prefix &&
    fromLines[fromLines.length - 1 - suffix] === toLines[toLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  if (prefix === fromLines.length && prefix === toLines.length) {
    return '';
  }

  const start = Math.max(0, prefix - context);
  const fromEnd = Math.min(fromLines.length, fromLines.length - suffix + context);
  const toEnd = Math.min(toLines.length, toLines.length - suffix + context);
  const lines = [
    `--- ${fromLabel}`,
    `+++ ${toLabel}`,
    `@@ -${start + 1},${fromEnd - start} +${start + 1},${toEnd - start} @@`,
    ...fromLines.slice(start, prefix).map(line => ` ${line}`),
    ...fromLines.slice(prefix, fromLines.length - suffix).map(line => `-${line}`),
    ...toLines.slice(prefix, toLines.length - suffix).map(line => `+${line}`),
    ...fromLines.slice(fromLines.length - suffix, fromEnd).map(line => ` ${line}`),
  ];

  return `${lines.join('\n')}\n`;
};

const main = async () => {
  const checkOnly = process.argv.includes('--check');
  const unknown = process.argv.slice(2).filter(arg => arg !== '--check');

  if (unknown.length > 0) {
    console.error(`Unknown argument: ${unknown.join(' ')}`);
    process.exitCode = 2;
    return;
  }

  const { result, source } = await readToolsList();
  const sha256 = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  const generated = formatTypeScript(renderContract({ result, sha256 }));

  if (!checkOnly) {
    await writeFile(OUTPUT_PATH, generated, 'utf8');
    console.log(
      `Wrote ${OUTPUT_PATH} from ${source} (${result.tools.length} tools, sha256 ${sha256}).`
    );
    return;
  }

  let committed = '';

  try {
    committed = await readFile(OUTPUT_PATH, 'utf8');
  } catch {
    committed = '';
  }

  if (committed === generated) {
    console.log(
      `${OUTPUT_PATH} matches ${source} (${result.tools.length} tools, sha256 ${sha256}).`
    );
    return;
  }

  process.stdout.write(
    buildUnifiedDiff({
      from: committed,
      fromLabel: OUTPUT_LABEL,
      to: generated,
      toLabel: `${GENERATION_COMMAND} output`,
    })
  );
  console.error(`${OUTPUT_PATH} is out of date with ${source}. Re-run ${GENERATION_COMMAND}.`);
  process.exitCode = 1;
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
