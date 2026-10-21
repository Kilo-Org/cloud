import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  isSafeSkillFilePath,
  RuntimeSkillsSchema,
  type RuntimeSkillInput,
} from '../../src/shared/runtime-profile.js';
import { createSafeProcessDiagnostic, runProcess } from './utils.js';
import { workspaceBootstrapError } from './bootstrap-error.js';

export type RuntimeSkillInstallOptions = {
  run?: typeof runProcess;
  signal?: AbortSignal;
  onProgress?: (detail: string) => void;
};

async function installSkillsShSkill(
  skillDir: string,
  source: string,
  name: string,
  options: RuntimeSkillInstallOptions,
  signal: AbortSignal
): Promise<void> {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-skills-'));
  const networkEnv: NodeJS.ProcessEnv = {};
  for (const key of [
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'CURL_CA_BUNDLE',
    'GIT_SSL_CAINFO',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ]) {
    if (process.env[key] !== undefined) networkEnv[key] = process.env[key];
  }
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      signal.throwIfAborted();
      options.onProgress?.(`Installing skills.sh skill ${source}@${name} (attempt ${attempt}/2)`);
      const result = await (options.run ?? runProcess)(
        'pnpm',
        [
          'dlx',
          'skills@1.7.4',
          'add',
          source,
          '--skill',
          name,
          '--global',
          '--agent',
          'kilo',
          '--copy',
          '--yes',
        ],
        {
          cwd: staging,
          inheritEnv: false,
          env: {
            ...networkEnv,
            PATH: process.env.PATH,
            HOME: staging,
            XDG_CONFIG_HOME: path.join(staging, '.config'),
            CI: '1',
            DISABLE_TELEMETRY: '1',
            GIT_TERMINAL_PROMPT: '0',
          },
          timeoutMs: 60_000,
          maxOutputBytes: 8_192,
          signal,
        }
      );
      signal.throwIfAborted();
      if (result.exitCode !== 0) {
        if (attempt < 2) continue;
        throw workspaceBootstrapError(
          result.terminationReason ? 'setup_command_timeout' : 'setup_command_failed',
          `Failed to install skills.sh skill ${source}@${name}: ${createSafeProcessDiagnostic(result)}`
        );
      }
      // skills@1.7.4 treats Kilo as a universal agent and installs to ~/.agents/skills.
      const installed = path.join(staging, '.agents', 'skills', name);
      const manifest = await fs.stat(path.join(installed, 'SKILL.md')).catch(() => undefined);
      if (!manifest?.isFile() || manifest.size === 0) {
        throw workspaceBootstrapError(
          'setup_command_failed',
          `skills.sh skill ${source}@${name} did not install a SKILL.md`,
          undefined,
          false
        );
      }
      await fs.cp(installed, skillDir, { recursive: true });
      return;
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    options.onProgress?.(
      `Failed to install skills.sh skill ${source}@${name}${signal.aborted ? ': installation timed out' : ''}`
    );
    if (signal.aborted) {
      throw workspaceBootstrapError(
        'setup_command_timeout',
        `skills.sh installation timed out while installing ${source}@${name}`
      );
    }
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/** Write validated skills under a session-owned home. */
export async function writeRuntimeSkills(
  home: string,
  skills: readonly RuntimeSkillInput[] = [],
  options: RuntimeSkillInstallOptions = {}
): Promise<void> {
  if (!skills.length) return;
  // Legacy session/ready payloads can contain unsafe companion paths. Preserve
  // their skip behavior; the control-plane request schema rejects these earlier.
  const validated = RuntimeSkillsSchema.parse(
    skills.map(skill => ({
      ...skill,
      ...(!('files' in skill) || skill.files === undefined
        ? {}
        : {
            files: Object.fromEntries(
              Object.entries(skill.files).filter(([name]) => isSafeSkillFilePath(name))
            ),
          }),
    }))
  );
  const baseDir = path.join(home, '.kilocode', 'skills');
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(180_000)])
    : AbortSignal.timeout(180_000);

  for (const skill of validated) {
    signal.throwIfAborted();
    const skillDir = path.join(baseDir, skill.name);
    if (skill.source !== undefined) {
      await installSkillsShSkill(skillDir, skill.source, skill.name, options, signal);
      continue;
    }
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), skill.rawMarkdown);
    for (const [relativePath, content] of Object.entries(skill.files ?? {})) {
      const targetPath = path.join(skillDir, relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content);
    }
  }
}
