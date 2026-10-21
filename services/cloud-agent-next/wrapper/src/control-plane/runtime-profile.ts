import fs from 'node:fs/promises';
import path from 'node:path';
import type { ControlPlaneRouteSpec } from '../../../src/shared/control-plane-protocol.js';
import {
  buildAgentEntryFromRuntimeAgent,
  buildKiloCommandsConfiguration,
} from '../../../src/shared/runtime-profile-config.js';
import { writeRuntimeSkills, type RuntimeSkillInstallOptions } from '../runtime-skills.js';

type RuntimeProfile = Pick<
  ControlPlaneRouteSpec,
  'runtimeSkills' | 'runtimeAgents' | 'kiloCommands'
>;

const profileWrites = new Map<string, Promise<void>>();

export function profileConfigPath(home: string): string {
  return path.join(home, '.config', 'kilo', 'profile.json');
}

/** Disk-backed profile config keeps large prompts/templates out of the process environment. */
export function withRuntimeProfileEnvironment(
  env: Record<string, string>,
  profile: RuntimeProfile
): Record<string, string> {
  if (!profile.runtimeAgents?.length && !profile.kiloCommands?.length) return env;
  return { ...env, KILO_CONFIG: profileConfigPath(env.HOME) };
}

export async function materializeRuntimeProfile(
  home: string,
  profile: RuntimeProfile,
  options?: RuntimeSkillInstallOptions
): Promise<void> {
  const previous = profileWrites.get(home) ?? Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(() => stageRuntimeProfile(home, profile, options));
  profileWrites.set(home, write);
  try {
    await write;
  } finally {
    if (profileWrites.get(home) === write) profileWrites.delete(home);
  }
}

async function stageRuntimeProfile(
  home: string,
  profile: RuntimeProfile,
  options?: RuntimeSkillInstallOptions
): Promise<void> {
  options?.signal?.throwIfAborted();
  await fs.mkdir(home, { recursive: true });
  const staging = await fs.mkdtemp(path.join(home, '.profile-'));
  try {
    await writeRuntimeSkills(staging, profile.runtimeSkills, options);
    const stagedSkills = path.join(staging, '.kilocode', 'skills');
    await fs.mkdir(stagedSkills, { recursive: true });
    const skills = path.join(home, '.kilocode', 'skills');
    const backup = path.join(staging, 'previous-skills');
    await fs.mkdir(path.dirname(skills), { recursive: true });
    options?.signal?.throwIfAborted();
    let hadSkills = false;
    try {
      await fs.rename(skills, backup);
      hadSkills = true;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    try {
      await fs.rename(stagedSkills, skills);
    } catch (error) {
      if (hadSkills) await fs.rename(backup, skills);
      throw error;
    }
    await writeRuntimeProfileConfig(home, profile);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function writeRuntimeProfileConfig(home: string, profile: RuntimeProfile): Promise<void> {
  const config = {
    ...(profile.runtimeAgents?.length
      ? {
          agent: Object.fromEntries(
            profile.runtimeAgents.map(agent => [agent.slug, buildAgentEntryFromRuntimeAgent(agent)])
          ),
        }
      : {}),
    ...(profile.kiloCommands?.length
      ? { command: buildKiloCommandsConfiguration(profile.kiloCommands) }
      : {}),
  };
  const file = profileConfigPath(home);
  if (Object.keys(config).length === 0) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
}
