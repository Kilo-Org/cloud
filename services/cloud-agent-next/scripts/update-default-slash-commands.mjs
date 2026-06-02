#!/usr/bin/env node
/**
 * Fetch the current Kilo CLI slash-command catalog and regenerate
 * `src/shared/default-slash-commands.generated.ts`.
 *
 * Rules (matching the Kilo TUI):
 *   - Exclude commands where source === "skill" (skills are hidden from slash autocomplete)
 *   - Sort deterministically by name
 *   - Strip the `template` field (server-side only)
 *
 * Usage:
 *   pnpm --filter cloud-agent-next update-default-slash-commands
 */

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const KILO_BIN = process.env.KILO_BIN_PATH || 'kilo';
const OUT_FILE = new URL('../src/shared/default-slash-commands.generated.ts', import.meta.url);

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function runKiloServer(port, cwd, home) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      HOME: home,
      KILO_DISABLE_PROJECT_CONFIG: '1',
    };
    const proc = spawn(KILO_BIN, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => {
      stdout += d;
    });
    proc.stderr.on('data', d => {
      stderr += d;
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('kilo server failed to start within 15s'));
    }, 15000);

    proc.on('error', err => {
      clearTimeout(timeout);
      reject(err);
    });

    const checkReady = setInterval(() => {
      if (stdout.includes('listening on') || stderr.includes('listening on')) {
        clearTimeout(timeout);
        clearInterval(checkReady);
        resolve(proc);
      }
    }, 100);

    proc.on('exit', code => {
      clearInterval(checkReady);
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(
          new Error(`kilo server exited with code ${code}\nstdout: ${stdout}\nstderr: ${stderr}`)
        );
      }
    });
  });
}

function killAndWait(proc) {
  return new Promise(resolve => {
    if (!proc || proc.killed || proc.exitCode !== null) {
      resolve();
      return;
    }
    proc.once('exit', () => resolve());
    proc.once('error', () => resolve());
    proc.kill();
    // fallback: force-kill after 3s
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, 3000);
  });
}

async function fetchCommands(port) {
  const url = `http://127.0.0.1:${port}/command`;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Failed to fetch /command from kilo server');
}

async function getKiloVersion() {
  try {
    const res = await new Promise((resolve, reject) => {
      const proc = spawn(KILO_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout.on('data', d => {
        out += d;
      });
      proc.on('close', code => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(`exit ${code}`));
      });
    });
    return res;
  } catch {
    return 'unknown';
  }
}

function hints(template) {
  if (typeof template !== 'string') return [];
  const result = [];
  const numbered = template.match(/\$\d+/g);
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match);
  }
  if (template.includes('$ARGUMENTS')) result.push('$ARGUMENTS');
  return result;
}

function trimCommand(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = raw.name;
  if (typeof name !== 'string' || name.length === 0) return null;

  const trimmed = {
    name,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    agent: typeof raw.agent === 'string' ? raw.agent : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    source:
      raw.source === 'command' || raw.source === 'mcp' || raw.source === 'skill'
        ? raw.source
        : undefined,
    subtask: typeof raw.subtask === 'boolean' ? raw.subtask : undefined,
    hints: hints(raw.template),
  };

  // omit undefined keys for cleaner output
  return Object.fromEntries(Object.entries(trimmed).filter(([, v]) => v !== undefined));
}

async function main() {
  const version = await getKiloVersion();
  console.log(`kilo version: ${version}`);

  const port = await getFreePort();
  console.log(`starting kilo server on port ${port} ...`);

  const tmpHome = await mkdtemp(`${tmpdir()}/kilo-home-`);
  const tmpDir = await mkdtemp(`${tmpdir()}/kilo-cmd-`);
  let proc;
  try {
    proc = await runKiloServer(port, tmpDir, tmpHome);
    console.log('kilo server started, fetching /command ...');

    const raw = await fetchCommands(port);
    const commands = raw
      .map(trimCommand)
      .filter(Boolean)
      // Match TUI behavior: skills are hidden from slash autocomplete
      .filter(cmd => cmd.source !== 'skill')
      .sort((a, b) => a.name.localeCompare(b.name));

    console.log(`fetched ${raw.length} commands, ${commands.length} after filtering skills`);

    const sourceLine = `kilo@${version}`;
    const json = JSON.stringify(commands, null, 2);

    const file = `export type SlashCommandInfo = {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  source?: 'command' | 'mcp' | 'skill';
  hints: string[];
  subtask?: boolean;
};

/**
 * Source Kilo version / ref used to generate this catalog.
 *
 * Note: skills (source: 'skill') are intentionally omitted. The Kilo TUI
 * filters them from slash-command autocomplete, so they never appear in the
 * local \`/\` list even though they can be invoked by typing the name manually.
 *
 * Regenerate with \`pnpm --filter cloud-agent-next update-default-slash-commands\`.
 */
export const DEFAULT_SLASH_COMMANDS_SOURCE = '${sourceLine}';

/**
 * Default slash command catalog used when no live wrapper-reported catalog is
 * available. Sorted deterministically by name. Keep in sync with Kilo releases.
 */
export const DEFAULT_SLASH_COMMANDS = ${json.replace(/"([^"]+)":/g, '$1:')} satisfies SlashCommandInfo[];
`;

    await writeFile(OUT_FILE, file, 'utf-8');
    console.log(`wrote ${OUT_FILE.pathname}`);
  } finally {
    if (proc) {
      await killAndWait(proc);
      console.log('kilo server stopped');
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
