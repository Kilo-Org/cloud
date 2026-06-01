import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const SERVICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG_PATH = path.join(SERVICE_DIR, 'wrangler.outbound-git-rewrite-dind-probe.jsonc');
const DOCKER_PRIVILEGED_PROXY = path.join(SERVICE_DIR, 'scripts/docker-privileged-proxy.mjs');
const STARTUP_TIMEOUT_MS = 600_000;
const PROBE_TIMEOUT_MS = 300_000;
const execFileAsync = promisify(execFile);

type Protocol = 'http' | 'https';
type CaPropagation = 'explicit' | 'none';
type ExpectedOutcome = 'success' | 'tls-rejection' | 'auth-rejection';

type ProbePayload = {
  ok: boolean;
  protocol?: Protocol;
  caPropagation?: CaPropagation;
  expectedOutcome?: ExpectedOutcome;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
};

type ProbeObservation = {
  label: string;
  httpStatus?: number;
  payload?: ProbePayload;
  transportError?: string;
};

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('could not allocate a local port'));
        return;
      }
      const { port } = address;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForHealth(
  baseUrl: string,
  processOutput: () => string,
  processExited: () => boolean
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (processExited()) {
      throw new Error(
        `wrangler DIND probe worker exited before becoming healthy\n${processOutput()}`
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Wrangler may still be building the local DIND Sandbox image.
    }
    await wait(500);
  }
  throw new Error(`wrangler DIND probe worker did not become healthy\n${processOutput()}`);
}

async function invokeProbe(
  baseUrl: string,
  label: string,
  pathName: string
): Promise<ProbeObservation> {
  try {
    const response = await fetch(`${baseUrl}${pathName}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const payload = (await response.json()) as ProbePayload;
    return { label, httpStatus: response.status, payload };
  } catch (error) {
    return { label, transportError: error instanceof Error ? error.message : String(error) };
  }
}

function printObservation(observation: ProbeObservation): void {
  if (observation.transportError) {
    console.log(`${observation.label} FAIL transport=${observation.transportError}`);
    return;
  }

  const payload = observation.payload;
  console.log(
    `${observation.label} ${payload?.ok ? 'PASS' : 'FAIL'} status=${observation.httpStatus ?? 'unknown'} exitCode=${payload?.exitCode ?? 'n/a'} expected=${payload?.expectedOutcome ?? 'unknown'} ca=${payload?.caPropagation ?? 'unknown'}`
  );
  if (payload?.stdout) console.log(`${observation.label} stdout:\n${payload.stdout}`);
  if (payload?.stderr) console.log(`${observation.label} stderr:\n${payload.stderr}`);
  if (payload?.error) console.log(`${observation.label} error=${payload.error}`);
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function waitForSocket(socketPath: string, processExited: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (processExited())
      throw new Error('Docker privileged proxy exited before opening its socket');
    if (fs.existsSync(socketPath)) return;
    await wait(100);
  }
  throw new Error(`Docker privileged proxy socket not found at ${socketPath}`);
}

async function fetchSandboxDoId(baseUrl: string, probeId: string): Promise<string> {
  const response = await fetch(`${baseUrl}/sandbox-id?probeId=${encodeURIComponent(probeId)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`probe sandbox ID request returned HTTP ${response.status}`);
  const body = (await response.json()) as { sandboxDoId?: string };
  if (!body.sandboxDoId) throw new Error('probe sandbox ID response did not include sandboxDoId');
  return body.sandboxDoId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cleanupSandbox(baseUrl: string, probeId: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${baseUrl}/cleanup?probeId=${encodeURIComponent(probeId)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
    });
    return response.ok ? undefined : `probe sandbox cleanup returned HTTP ${response.status}`;
  } catch (error) {
    return `probe sandbox cleanup failed: ${errorMessage(error)}`;
  }
}

async function invocationArtifactExists(name: string): Promise<boolean> {
  try {
    await execFileAsync('docker', ['container', 'inspect', name]);
    return true;
  } catch (error) {
    const message = errorMessage(error);
    if (/No such (?:object|container)/i.test(message)) return false;
    throw new Error(`could not inspect invocation-specific Docker artifact ${name}: ${message}`);
  }
}

async function removeInvocationDockerArtifacts(sandboxDoId: string | undefined): Promise<string[]> {
  if (!sandboxDoId) return [];
  const errors: string[] = [];
  const sandboxName = `workerd-cloud-agent-next-outbound-git-rewrite-dind-probe-OutboundGitRewriteDindProbeSandbox-${sandboxDoId}`;
  const names = [sandboxName, `${sandboxName}-proxy`];
  for (const name of names) {
    try {
      if (await invocationArtifactExists(name)) await execFileAsync('docker', ['rm', '-f', name]);
    } catch (error) {
      errors.push(`probe Docker artifact cleanup failed for ${name}: ${errorMessage(error)}`);
    }
  }
  for (const name of names) {
    try {
      if (await invocationArtifactExists(name)) {
        errors.push(`probe cleanup left Docker artifact: ${name}`);
        continue;
      }
      console.log(`CLEANUP Docker artifact absent: ${name}`);
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }
  return errors;
}

function casePassed(observation: ProbeObservation): boolean {
  return observation.payload?.ok === true;
}

async function main(): Promise<void> {
  const port = await reservePort();
  const probeId = `probe-${randomUUID()}`;
  const output: string[] = [];
  const dockerProxySocket = path.join(os.tmpdir(), `dind-probe-${randomUUID().slice(0, 8)}.sock`);
  const dockerProxy = spawn('node', [DOCKER_PRIVILEGED_PROXY], {
    cwd: SERVICE_DIR,
    env: { ...process.env, DOCKER_PROXY_SOCKET: dockerProxySocket },
  });
  const captureOutput = (chunk: Buffer): void => {
    output.push(chunk.toString('utf8'));
  };
  dockerProxy.stdout.on('data', captureOutput);
  dockerProxy.stderr.on('data', captureOutput);
  let wrangler: ChildProcessWithoutNullStreams | undefined;
  const baseUrl = `http://127.0.0.1:${port}`;
  let workerReady = false;
  let sandboxDoId: string | undefined;

  try {
    await waitForSocket(
      dockerProxySocket,
      () => dockerProxy.exitCode !== null || dockerProxy.signalCode !== null
    );
    wrangler = spawn(
      'pnpm',
      [
        'exec',
        'wrangler',
        'dev',
        '--config',
        CONFIG_PATH,
        '--env-file',
        '/dev/null',
        '--local',
        '--port',
        String(port),
        '--show-interactive-dev-session=false',
        '--log-level=log',
      ],
      { cwd: SERVICE_DIR, env: { ...process.env, DOCKER_HOST: `unix://${dockerProxySocket}` } }
    );
    wrangler.stdout.on('data', captureOutput);
    wrangler.stderr.on('data', captureOutput);
    const spawnedWrangler = wrangler;
    await waitForHealth(
      baseUrl,
      () => output.join(''),
      () => spawnedWrangler.exitCode !== null || spawnedWrangler.signalCode !== null
    );
    workerReady = true;
    const idQuery = `probeId=${encodeURIComponent(probeId)}`;
    sandboxDoId = await fetchSandboxDoId(baseUrl, probeId);
    const gitHttp = await invokeProbe(
      baseUrl,
      'NESTED_GIT_HTTP_REWRITE',
      `/probe?${idQuery}&protocol=http&ca=none`
    );
    const gitHttpsWithCa = await invokeProbe(
      baseUrl,
      'NESTED_GIT_HTTPS_REWRITE_WITH_CA',
      `/probe?${idQuery}&protocol=https&ca=explicit`
    );
    const gitHttpsWithoutCa = await invokeProbe(
      baseUrl,
      'NESTED_GIT_HTTPS_WITHOUT_CA_NEGATIVE',
      `/probe?${idQuery}&protocol=https&ca=none`
    );
    const retainedAuth = await invokeProbe(
      baseUrl,
      'NESTED_GIT_HTTPS_RETAIN_AUTH_NEGATIVE',
      `/probe?${idQuery}&protocol=https&ca=explicit&mode=retain`
    );
    const observations = [gitHttp, gitHttpsWithCa, gitHttpsWithoutCa, retainedAuth];
    for (const observation of observations) printObservation(observation);

    if (observations.every(casePassed)) {
      console.log(
        'RESULT nested --network=host routing, explicit nested CA propagation, missing-CA TLS rejection, and retained-placeholder auth rejection validated.'
      );
      return;
    }
    console.log('RESULT Required nested DIND outbound Git rewrite assertions failed.');
    process.exitCode = 1;
  } finally {
    const cleanupErrors: string[] = [];
    if (workerReady) {
      const sandboxCleanupError = await cleanupSandbox(baseUrl, probeId);
      if (sandboxCleanupError) cleanupErrors.push(sandboxCleanupError);
    }
    if (wrangler) await stopProcess(wrangler);
    cleanupErrors.push(...(await removeInvocationDockerArtifacts(sandboxDoId)));
    await stopProcess(dockerProxy);
    fs.rmSync(dockerProxySocket, { force: true });
    if (cleanupErrors.length > 0) {
      process.exitCode = 1;
      console.error(`CLEANUP FAIL\n${cleanupErrors.map(error => `- ${error}`).join('\n')}`);
    }
    const wranglerOutput = output.join('').trim();
    if (process.exitCode && wranglerOutput) {
      console.log(`WRANGLER output:\n${wranglerOutput}`);
    }
  }
}

main().catch(error => {
  console.error(
    'DIND probe runner failed:',
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});
