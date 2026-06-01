import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const SERVICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG_PATH = path.join(SERVICE_DIR, 'wrangler.outbound-git-rewrite-probe.jsonc');
const STARTUP_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 180_000;
const execFileAsync = promisify(execFile);

type Protocol = 'http' | 'https';

type ProbePayload = {
  ok: boolean;
  protocol?: Protocol;
  expectedSuccess?: boolean;
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
      throw new Error(`wrangler probe worker exited before becoming healthy\n${processOutput()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Wrangler may still be building the local Sandbox image.
    }
    await wait(500);
  }
  throw new Error(`wrangler probe worker did not become healthy\n${processOutput()}`);
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
  const expectation = payload?.expectedSuccess === false ? ' expected=git-failure' : '';
  console.log(
    `${observation.label} ${payload?.ok ? 'PASS' : 'FAIL'} status=${observation.httpStatus ?? 'unknown'} exitCode=${payload?.exitCode ?? 'n/a'}${expectation}`
  );
  if (payload?.stdout) console.log(`${observation.label} stdout:\n${payload.stdout}`);
  if (payload?.stderr) console.log(`${observation.label} stderr:\n${payload.stderr}`);
  if (payload?.error) console.log(`${observation.label} error=${payload.error}`);
}

async function stopWorker(child: ChildProcessWithoutNullStreams): Promise<void> {
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

async function cleanupSandbox(baseUrl: string, probeId: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${baseUrl}/cleanup?probeId=${encodeURIComponent(probeId)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      console.warn(`probe sandbox cleanup returned HTTP ${response.status}`);
      return undefined;
    }
    const body = (await response.json()) as { sandboxDoId?: string };
    return body.sandboxDoId;
  } catch (error) {
    console.warn(
      `probe sandbox cleanup failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

async function invocationProxyExists(proxyName: string): Promise<boolean> {
  try {
    await execFileAsync('docker', ['container', 'inspect', proxyName]);
    return true;
  } catch {
    return false;
  }
}

async function removeInvocationProxyArtifact(sandboxDoId: string | undefined): Promise<void> {
  if (!sandboxDoId) return;
  const proxyName = `workerd-cloud-agent-next-outbound-git-rewrite-probe-OutboundGitRewriteProbeSandbox-${sandboxDoId}-proxy`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await invocationProxyExists(proxyName)) {
      try {
        await execFileAsync('docker', ['rm', '-f', proxyName]);
      } catch (error) {
        console.warn(
          `probe proxy cleanup failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return;
      }
    }
    await wait(100);
  }
  if (await invocationProxyExists(proxyName)) {
    console.warn(`probe proxy cleanup left artifact: ${proxyName}`);
    return;
  }
  console.log(`CLEANUP proxy artifact absent: ${proxyName}`);
}

async function main(): Promise<void> {
  const port = await reservePort();
  const probeId = `probe-${randomUUID()}`;
  const output: string[] = [];
  const wrangler = spawn(
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
    { cwd: SERVICE_DIR, env: process.env }
  );
  const captureOutput = (chunk: Buffer): void => {
    output.push(chunk.toString('utf8'));
  };
  wrangler.stdout.on('data', captureOutput);
  wrangler.stderr.on('data', captureOutput);
  const baseUrl = `http://127.0.0.1:${port}`;
  let workerReady = false;

  try {
    await waitForHealth(
      baseUrl,
      () => output.join(''),
      () => wrangler.exitCode !== null || wrangler.signalCode !== null
    );
    workerReady = true;
    const idQuery = `probeId=${encodeURIComponent(probeId)}`;
    const gitHttp = await invokeProbe(baseUrl, 'GIT_HTTP', `/probe?${idQuery}&protocol=http`);
    const gitHttps = await invokeProbe(baseUrl, 'GIT_HTTPS', `/probe?${idQuery}&protocol=https`);
    const retainedAuth = await invokeProbe(
      baseUrl,
      'GIT_HTTPS_RETAIN_AUTH_NEGATIVE',
      `/probe?${idQuery}&protocol=https&mode=retain`
    );
    printObservation(gitHttp);
    printObservation(gitHttps);
    printObservation(retainedAuth);

    if (
      gitHttp.payload?.ok === true &&
      gitHttps.payload?.ok === true &&
      retainedAuth.payload?.ok === true
    ) {
      console.log(
        'RESULT HTTP and HTTPS rewrite validated; retained-placeholder negative control validated.'
      );
      return;
    }
    console.log('RESULT Required outbound Git rewrite assertions failed.');
    process.exitCode = 1;
  } finally {
    const sandboxDoId = workerReady ? await cleanupSandbox(baseUrl, probeId) : undefined;
    await stopWorker(wrangler);
    await removeInvocationProxyArtifact(sandboxDoId);
    const wranglerOutput = output.join('').trim();
    if (process.exitCode && wranglerOutput) {
      console.log(`WRANGLER output:\n${wranglerOutput}`);
    }
  }
}

main().catch(error => {
  console.error('probe runner failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
