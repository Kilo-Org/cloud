import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { constants, type Stats } from 'node:fs';
import fs, { access, lchown, mkdir, open, readdir, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  AGENT_GID,
  AGENT_UID,
  inheritedAgentEnvironment,
} from '../../../src/shared/runtime-environment.js';

let isolated = false;
/** Root-owned executable directories; root never resolves a command through an agent PATH. */
export const TRUSTED_EXECUTABLE_PATH = '/usr/local/bin:/usr/bin:/bin';
const launcherEnvironment = { PATH: TRUSTED_EXECUTABLE_PATH, LANG: 'C.UTF-8' };

export async function initializeAgentExecution(): Promise<void> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new Error('Agent isolation requires a privileged Linux wrapper');
  }
  await access('/usr/bin/setpriv');
  isolated = true;
}

export function agentCommand(command: string, args: string[], env?: NodeJS.ProcessEnv) {
  if (!isolated) return { command, args, env };
  const environment = env ?? inheritedAgentEnvironment(process.env);
  return {
    command: '/usr/bin/setpriv',
    args: [
      `--reuid=${AGENT_UID}`,
      `--regid=${AGENT_GID}`,
      '--clear-groups',
      '--bounding-set=-all',
      '--inh-caps=-all',
      '--ambient-caps=-all',
      '--no-new-privs',
      '--',
      '/usr/bin/env',
      '-i',
      '--',
      ...Object.entries(environment).flatMap(([key, value]) =>
        value === undefined ? [] : [`${key}=${value}`]
      ),
      command,
      ...args,
    ],
    // Loader and shell startup variables must not reach the privileged launcher.
    env: launcherEnvironment,
  };
}

export function spawnAgent(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
): ChildProcessWithoutNullStreams;
export function spawnAgent(command: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawnAgent(command: string, args: string[], options: SpawnOptions): ChildProcess {
  if (isolated && options.shell) {
    throw new Error('Agent isolation requires explicit shell arguments');
  }
  const child = agentCommand(command, args, options.env);
  return spawn(child.command, child.args, { ...options, env: child.env });
}

export async function agentOwns(file: string): Promise<void> {
  if (!isolated) return;
  const directory = await openAgentDirectory(path.dirname(file));
  try {
    await lchown(`/proc/self/fd/${directory.fd}/${path.basename(file)}`, AGENT_UID, AGENT_GID);
  } finally {
    await directory.close();
  }
}

export async function makeAgentDirectory(directoryPath: string, mode = 0o777): Promise<void> {
  if (!isolated) {
    await mkdir(directoryPath, { recursive: true, mode });
    return;
  }
  const directory = await openAgentDirectory(directoryPath, mode);
  await directory.close();
}

export async function chmodAgentDirectory(directoryPath: string, mode: number): Promise<void> {
  if (!isolated) return fs.chmod(directoryPath, mode);
  const directory = await openAgentDirectory(directoryPath);
  try {
    await directory.chmod(mode);
  } finally {
    await directory.close();
  }
}

export async function agentOwnsTree(directory: string): Promise<void> {
  if (!isolated) return;
  const pinned = await openAgentDirectory(directory);
  try {
    await ownTree(pinned, await pinned.stat());
  } finally {
    await pinned.close();
  }
}

// A multiply linked file can be a root file outside the tree; it stays unchanged.
async function ownTree(directory: FileHandle, stat: Stats): Promise<void> {
  await ownHandle(directory, stat);
  const base = `/proc/self/fd/${directory.fd}`;
  for (const name of await readdir(base)) {
    let entry: FileHandle;
    try {
      entry = await open(
        `${base}/${name}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY
      );
    } catch (error) {
      // Symlinks, sockets and entries removed during the walk keep their owner.
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ELOOP' || error.code === 'ENXIO' || error.code === 'ENOENT')
      )
        continue;
      throw error;
    }
    try {
      const entryStat = await entry.stat();
      if (entryStat.isDirectory()) await ownTree(entry, entryStat);
      else if (entryStat.nlink === 1) await ownHandle(entry, entryStat);
    } finally {
      await entry.close();
    }
  }
}

async function ownHandle(handle: FileHandle, stat: Stats): Promise<void> {
  if (stat.uid !== AGENT_UID || stat.gid !== AGENT_GID) await handle.chown(AGENT_UID, AGENT_GID);
}

async function openAgentDirectory(directoryPath: string, mode = 0o777) {
  const parts = path.resolve(directoryPath).split('/').filter(Boolean);
  let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of parts) {
      const target = `/proc/self/fd/${directory.fd}/${part}`;
      let created = false;
      try {
        await mkdir(target, mode);
        created = true;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
      const next = await open(
        target,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      await directory.close();
      directory = next;
      if (created && isolated) await directory.chown(AGENT_UID, AGENT_GID);
    }
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}

export async function openAgentFile(file: string, mode = 0o644): Promise<FileHandle> {
  if (!isolated) {
    await mkdir(path.dirname(file), { recursive: true });
    return open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      mode
    );
  }
  const directory = await openAgentDirectory(path.dirname(file));
  try {
    // Pin every parent and reject final symlinks before writing as the wrapper.
    const target = await open(
      `/proc/self/fd/${directory.fd}/${path.basename(file)}`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      mode
    );
    try {
      const stat = await target.stat();
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error('Agent file must be a single-link regular file');
      await target.truncate();
      await target.chown(AGENT_UID, AGENT_GID);
      return target;
    } catch (error) {
      await target.close();
      throw error;
    }
  } finally {
    await directory.close();
  }
}

export async function writeAgentFile(
  file: string,
  content: string | Uint8Array,
  mode = 0o644
): Promise<void> {
  const target = await openAgentFile(file, mode);
  try {
    await target.writeFile(content);
  } finally {
    await target.close();
  }
}

export async function renameAgentPath(source: string, destination: string): Promise<void> {
  if (!isolated) return fs.rename(source, destination);
  const from = await openAgentDirectory(path.dirname(source));
  try {
    const to = await openAgentDirectory(path.dirname(destination));
    try {
      await fs.rename(
        `/proc/self/fd/${from.fd}/${path.basename(source)}`,
        `/proc/self/fd/${to.fd}/${path.basename(destination)}`
      );
    } finally {
      await to.close();
    }
  } finally {
    await from.close();
  }
}
