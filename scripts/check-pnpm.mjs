#!/usr/bin/env node
// Ensures installs in this repository run under pnpm.
// Runs before any dependency install and must stay dependency-free.
import path from 'node:path';
import process from 'node:process';

const userAgent = process.env.npm_config_user_agent ?? '';
const execPath = process.env.npm_execpath ?? '';

function fail(installer) {
  console.error(
    [
      'This repository uses pnpm as its package manager.',
      `Detected ${installer}. Install with pnpm, e.g. via Corepack:`,
      '  corepack enable',
      '  corepack prepare pnpm@11.1.2 --activate',
      '  pnpm install',
    ].join('\n')
  );
  process.exit(1);
}

if (userAgent.startsWith('pnpm/')) {
  process.exit(0);
}

const installer = userAgent.split(' ')[0] || 'an unknown installer';
const execName = execPath ? path.basename(execPath) : '';
if (['pnpm', 'pnpm.cjs', 'pnpm.mjs'].includes(execName)) {
  process.exit(0);
}

fail(execName ? `${installer} (${execName})` : installer);
