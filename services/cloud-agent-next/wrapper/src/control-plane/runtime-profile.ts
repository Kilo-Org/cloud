import fs from 'node:fs/promises';
import path from 'node:path';
import type { ControlPlaneRouteSpec } from '../../../src/shared/control-plane-protocol.js';
import {
  buildAgentEntryFromRuntimeAgent,
  buildKiloCommandsConfiguration,
} from '../../../src/shared/runtime-profile-config.js';
import { writeRuntimeSkills } from '../runtime-skills.js';

type RuntimeProfile = Pick<
  ControlPlaneRouteSpec,
  'runtimeSkills' | 'runtimeAgents' | 'kiloCommands'
>;

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
  profile: RuntimeProfile
): Promise<void> {
  await fs.rm(path.join(home, '.kilocode', 'skills'), { recursive: true, force: true });
  await writeRuntimeSkills(home, profile.runtimeSkills);
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
