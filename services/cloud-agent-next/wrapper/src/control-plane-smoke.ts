import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ControlPlaneSmokeOptions = {
  supervisorPath: string;
  protocolVersion: number;
  allocationId: string;
  credential: string;
  timeoutMs: number;
  cleanupMs: number;
  scratchDir: string;
  timerDivisor: number;
  wrapperCommand?: string;
};

export type ControlPlaneSmokeHello = {
  wrapperId: string;
  allocationId: string;
  protocolVersion: number;
};

export type ControlPlaneSmokeResult = ControlPlaneSmokeHello & {
  connected: boolean;
  authenticated: boolean;
  supervisorExitCode: number;
  supervisorRestarts: number;
};

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

export function parseSmokeArgs(argv: string[]): ControlPlaneSmokeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new Error(`unexpected argument: ${item}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--'))
      throw new Error(`--${item.slice(2)} requires a value`);
    values.set(item.slice(2), next);
    index++;
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) throw new Error(`--${name} is required`);
    return value;
  };
  return {
    supervisorPath: required('supervisor'),
    protocolVersion: parsePositiveInt(required('protocol-version'), 'protocol-version'),
    allocationId: required('allocation-id'),
    credential: values.get('credential') ?? `smoke-${randomUUID()}`,
    timeoutMs: parsePositiveInt(values.get('timeout-ms') ?? '45000', 'timeout-ms'),
    cleanupMs: parsePositiveInt(values.get('cleanup-ms') ?? '5000', 'cleanup-ms'),
    scratchDir: values.get('scratch-dir') ?? join(tmpdir(), `cp-smoke-${randomUUID()}`),
    timerDivisor: parsePositiveInt(values.get('timer-divisor') ?? '20', 'timer-divisor'),
    ...(values.get('wrapper-command') ? { wrapperCommand: values.get('wrapper-command') } : {}),
  };
}

export function smokeWelcomeFrame(protocolVersion: number): {
  type: 'welcome';
  protocolVersion: number;
} {
  return { type: 'welcome', protocolVersion };
}

export function smokeShutdownFrame(reason: string): { type: 'shutdown'; reason: string } {
  return { type: 'shutdown', reason };
}

export function validateSmokeHello(
  frame: Record<string, unknown>,
  expected: { allocationId: string; protocolVersion: number }
): ControlPlaneSmokeHello {
  if (frame.type !== 'hello') throw new Error('control-plane sent a non-hello first frame');
  if (typeof frame.wrapperId !== 'string' || frame.wrapperId.length === 0)
    throw new Error('control-plane hello has no wrapperId');
  if (frame.allocationId !== expected.allocationId)
    throw new Error('control-plane hello allocationId mismatch');
  if (frame.protocolVersion !== expected.protocolVersion)
    throw new Error('control-plane hello protocolVersion mismatch');
  return {
    wrapperId: frame.wrapperId,
    allocationId: expected.allocationId,
    protocolVersion: expected.protocolVersion,
  };
}

export function smokeSupervisorEnv(
  options: ControlPlaneSmokeOptions,
  url: string,
  home: string,
  logPath: string,
  baseEnv: Record<string, string | undefined>
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined || key === 'CONTROL_PLANE_WRAPPER_COMMAND') continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    SANDBOX_CONTROL_URL: url,
    SANDBOX_CONTROL_CREDENTIAL: options.credential,
    CONTROL_PLANE_ALLOCATION_ID: options.allocationId,
    WRAPPER_LOG_PATH: logPath,
    CONTROL_PLANE_NATIVE_LOGS: '1',
    CONTROL_PLANE_TIMER_DIVISOR: String(options.timerDivisor),
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    ...(options.wrapperCommand ? { CONTROL_PLANE_WRAPPER_COMMAND: options.wrapperCommand } : {}),
  };
}

function decodeFrame(raw: string | BufferSource): string {
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

async function raceExit(proc: Bun.Subprocess, timeoutMs: number): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      proc.exited,
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function terminateProcess(proc: Bun.Subprocess, graceMs: number): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  if ((await raceExit(proc, graceMs)) !== undefined) return;
  proc.kill('SIGKILL');
  await raceExit(proc, graceMs);
}

export async function runControlPlaneSmoke(
  options: ControlPlaneSmokeOptions
): Promise<ControlPlaneSmokeResult> {
  await mkdir(options.scratchDir, { recursive: true });
  const home = join(options.scratchDir, 'home');
  const logPath = join(options.scratchDir, 'wrapper.log');
  await mkdir(home, { recursive: true });

  let hello: ControlPlaneSmokeHello | undefined;
  let connected = false;
  let authenticated = false;
  const sockets = new Set<Bun.ServerWebSocket<undefined>>();

  const server = Bun.serve<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, srv) {
      authenticated = request.headers.get('authorization') === `Bearer ${options.credential}`;
      if (!authenticated) return new Response('unauthorized', { status: 401 });
      if (srv.upgrade(request)) return undefined;
      return new Response('upgrade required', { status: 426 });
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
      },
      message(socket, raw) {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(decodeFrame(raw)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (frame.type === 'hello') {
          if (!hello) {
            hello = validateSmokeHello(frame, options);
            socket.send(JSON.stringify(smokeWelcomeFrame(options.protocolVersion)));
          }
          return;
        }
        if (frame.type === 'heartbeat') connected = true;
      },
      close(socket) {
        sockets.delete(socket);
      },
    },
  });
  if (server.port === undefined) throw new Error('smoke server has no TCP port');
  const url = `ws://127.0.0.1:${server.port}/sandbox-control/smoke`;

  const deadline = Date.now() + options.timeoutMs;
  const remaining = (): number => deadline - Date.now();
  let proc: Bun.Subprocess | undefined;
  try {
    proc = Bun.spawn([options.supervisorPath], {
      env: smokeSupervisorEnv(options, url, home, logPath, process.env),
      stdout: 'ignore',
      stderr: 'pipe',
    });

    while (!connected && proc.exitCode === null && remaining() > 0) {
      await Bun.sleep(20);
    }
    if (!connected || !hello) throw new Error('control-plane did not connect and send a heartbeat');

    for (const socket of sockets) {
      try {
        socket.send(JSON.stringify(smokeShutdownFrame('snapshot-smoke')));
      } catch {
        // The socket may already be closing.
      }
    }

    const exitCode = await raceExit(proc, remaining());
    if (exitCode === undefined)
      throw new Error(`supervisor did not exit within ${options.timeoutMs}ms`);
    const stderr = await readStreamText(proc.stderr);
    if (exitCode !== 0) throw new Error(`supervisor exited ${exitCode}: ${stderr}`);
    if (!stderr.includes('"event":"supervisor_started"'))
      throw new Error('supervisor did not report startup');
    if (!stderr.includes('"event":"supervisor_exit","exitCode":0'))
      throw new Error('supervisor did not report a clean exit');
    if (stderr.includes('"event":"wrapper_restart"'))
      throw new Error('supervisor restarted the control-plane wrapper');

    return {
      ...hello,
      connected,
      authenticated,
      supervisorExitCode: exitCode,
      supervisorRestarts: 0,
    };
  } finally {
    if (proc) await terminateProcess(proc, options.cleanupMs);
    await server.stop(true);
    await rm(options.scratchDir, { recursive: true, force: true });
  }
}

async function readStreamText(stream: unknown): Promise<string> {
  if (!(stream instanceof ReadableStream)) return '';
  return new Response(stream).text();
}

if (import.meta.main) {
  try {
    const result = await runControlPlaneSmoke(parseSmokeArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `control-plane smoke failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
}
