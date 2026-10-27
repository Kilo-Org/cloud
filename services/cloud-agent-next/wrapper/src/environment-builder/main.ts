import fs from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import {
  ENVIRONMENT_BUILD_LOG_PATH,
  type EnvironmentBuildResult,
} from '../../../src/shared/environment-build-protocol.js';
import {
  SETUP_COMMAND_HARD_TIMEOUT_MS,
  SETUP_COMMAND_INACTIVITY_TIMEOUT_MS,
  createRepositoryPreparation,
} from '../control-plane/repository-preparation.js';
import { writeWorkspaceStamp } from '../control-plane/workspace-stamp.js';
import { git } from '../utils.js';
import { runSetupScript } from '../setup-script.js';
import { BuilderRefusedError, createBuilderClient } from './client.js';
import { removeBuildCredentials, stopOtherProcesses } from './cleanup.js';
import { createBuildReporter } from './reporter.js';
import { runEnvironmentBuild } from './run.js';
import { takeRunner } from './runner-file.js';

/**
 * Environment builder entry point: the main process of a dedicated builder
 * container. It runs no Kilo and holds no session state. After it reports its
 * result it stays alive and idle, so the coordinator can snapshot the running
 * container and then stop it.
 */

const REPORT_INTERVAL_MS = 2_000;

const logPath = ENVIRONMENT_BUILD_LOG_PATH;

function log(message: string): void {
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Diagnostics only.
  }
}

function idleUntilStopped(): Promise<never> {
  // An unresolved promise alone does not keep the process alive.
  setInterval(() => undefined, 1 << 30);
  return new Promise<never>(() => undefined);
}

async function main(): Promise<void> {
  const runner = await takeRunner();
  if (runner === null) {
    log('environment builder received no endpoint or credential');
    return idleUntilStopped();
  }
  const client = createBuilderClient({ baseUrl: runner.url, credential: runner.credential });
  const inherited = { ...process.env };

  let input;
  try {
    input = await client.input();
  } catch (error) {
    log(
      `environment builder input unavailable: ${error instanceof Error ? error.message : 'unknown'}`
    );
    if (!(error instanceof BuilderRefusedError)) {
      await client
        .result({ outcome: 'failed', step: 'clone', reason: 'input_unavailable' })
        .catch(() => undefined);
    }
    return idleUntilStopped();
  }

  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error('build deadline')),
    Math.max(0, input.deadlineAt - Date.now())
  );
  const reporter = createBuildReporter({
    client,
    intervalMs: REPORT_INTERVAL_MS,
    onCancel: () => controller.abort(new Error('build canceled')),
    log,
  });
  reporter.start();
  const repository = createRepositoryPreparation({
    runGit: (args, options) => git(args, options),
    runSetup: (command, directory, env, onOutput, signal) =>
      runSetupScript(command, {
        cwd: directory,
        env,
        inheritEnv: false,
        ...(signal ? { signal } : {}),
        inactivityTimeoutMs: SETUP_COMMAND_INACTIVITY_TIMEOUT_MS,
        hardTimeoutMs: SETUP_COMMAND_HARD_TIMEOUT_MS,
        ...(onOutput ? { onOutput } : {}),
      }),
    sleep: (ms, signal) =>
      new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      }),
    mkdir: directory => fs.mkdir(directory, { recursive: true }).then(() => undefined),
    hasGit: directory =>
      fs.access(`${directory}/.git/HEAD`).then(
        () => true,
        () => false
      ),
    log,
  });

  let result: EnvironmentBuildResult;
  try {
    result = await runEnvironmentBuild({
      input,
      reporter,
      repository,
      runGit: (args, options) => git(args, options),
      stopProcesses: () => stopOtherProcesses(),
      cleanup: removeBuildCredentials,
      writeStamp: (directory, stamp) => writeWorkspaceStamp(directory, true, stamp),
      signal: controller.signal,
      inherited,
      logPath,
    });
  } finally {
    clearTimeout(deadline);
  }
  log(`environment builder finished outcome=${result.outcome}`);
  reporter.stop();
  await reporter.flush();
  try {
    await client.result(result);
  } catch (error) {
    log(
      `environment builder result not delivered: ${error instanceof Error ? error.message : 'unknown'}`
    );
  }
  return idleUntilStopped();
}

void main().catch(error => {
  log(`environment builder failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return idleUntilStopped();
});
