import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { createHostControlPlaneClient } from './control-plane.js';
import { createEc2BootSource } from './ec2-host-bootstrap.js';
import { loadEc2TestAccess } from './ec2-test-access.js';
import { createHostCertificates } from './host-certificates.js';
import { createPublicResolver } from './resolver.js';
import { createTransparentHttpServer } from './transparent-http.js';
import { createTransparentTlsServer } from './transparent-tls.js';

const RUNTIME = '/run/kilo-ec2';
const STATE = '/var/lib/kilo-ec2';
const ASSETS = '/opt/kilo/ec2';
const BRIDGE = '192.168.251.1';
const workloadName = 'kilo-workload';
const STOP_TIMEOUT_SECONDS = 30;
const execute = promisify(execFile);
const ENTRYPOINT = [
  '--input-type=module',
  '-e',
  'import {startLaunchFromStdin} from "/opt/kilo/aws/launch-document.mjs"; startLaunchFromStdin().catch(()=>process.exit(1))',
] as const;
const DOCKER_MEMORY = 7 * 1024 ** 3;
const DOCKER_PIDS = 2048;
const WORKLOAD_TMPFS = 'rw,nosuid,noexec,nodev,mode=0755,size=4m';

const inspectionSchema = z.tuple([
  z.object({
    Image: z.string(),
    State: z.object({ Running: z.literal(false) }),
    Config: z.object({
      OpenStdin: z.literal(true),
      StdinOnce: z.literal(true),
      Tty: z.literal(false),
      User: z.literal('0'),
      Entrypoint: z.tuple([z.literal('/usr/local/bin/node')]),
      Cmd: z.tuple([z.literal(ENTRYPOINT[0]), z.literal(ENTRYPOINT[1]), z.literal(ENTRYPOINT[2])]),
    }),
    Mounts: z.tuple([]),
    HostConfig: z.object({
      Binds: z.tuple([]).nullish(),
      Privileged: z.literal(false),
      CapAdd: z.tuple([]).nullish(),
      CapDrop: z
        .array(z.string())
        .refine(caps => caps.includes('CAP_NET_RAW') || caps.includes('NET_RAW')),
      PortBindings: z.object({}).strict().nullish(),
      NetworkMode: z.literal('bridge'),
      PidMode: z.literal(''),
      UsernsMode: z.literal(''),
      Devices: z.tuple([]).nullish(),
      RestartPolicy: z.object({ Name: z.literal('no') }),
      LogConfig: z.object({ Type: z.literal('none') }),
      Dns: z.tuple([z.literal(BRIDGE)]),
      Memory: z.literal(DOCKER_MEMORY),
      MemorySwap: z.literal(DOCKER_MEMORY),
      PidsLimit: z.literal(DOCKER_PIDS),
      SecurityOpt: z.array(z.string()).refine(options => options.includes('no-new-privileges')),
      Tmpfs: z.object({ '/run/kilo-boot': z.literal(WORKLOAD_TMPFS) }),
    }),
  }),
]);

function service(program: string, args: string[]) {
  const child = spawn(program, args, { stdio: 'ignore' });
  child.on('error', () => {});
  return child;
}
async function stopService(child: ChildProcess | undefined, timeout: number) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit', { signal: AbortSignal.timeout(timeout) });
}

function inspectContainer(raw: string, imageId: string) {
  const inspection = inspectionSchema.safeParse(JSON.parse(raw));
  return inspection.success && inspection.data[0].Image === imageId;
}

async function startHost() {
  const signalController = new AbortController();
  process.once('SIGTERM', () => signalController.abort());
  process.once('SIGINT', () => signalController.abort());
  const { signal } = signalController;
  const command = async (program: string, args: string[], timeout = 15_000) => {
    try {
      const result = await execute(program, args, { timeout, maxBuffer: 1_048_576 });
      return result.stdout.trim();
    } catch {
      throw new Error('EC2 host command failed');
    }
  };
  const boot = createEc2BootSource({
    region: process.env.AWS_REGION ?? '',
    bucket: process.env.KILO_LAUNCH_BUCKET ?? '',
    fetch,
  });
  await mkdir(STATE, { recursive: true, mode: 0o700 });
  const replayPath = STATE + '/last-launch';
  const lastAllocation = await readFile(replayPath, 'utf8').then(
    text => text.trim().split(' ')[0],
    (error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      return undefined;
    }
  );
  // The tag can arrive after cloud-init. No workload or proxy runs during this interval.
  async function loadLaunch() {
    const until = Date.now() + 12 * 60_000;
    while (Date.now() < until) {
      signal.throwIfAborted();
      const launch = await boot.readLaunch(lastAllocation).catch(() => null);
      if (launch) return launch;
      await wait(1500, undefined, { signal });
    }
    throw new Error('EC2 launch grant unavailable');
  }
  const { host, workload } = await loadLaunch();
  let stage = 'storage';
  let clean = false;
  let mounted = false;
  let docker: ChildProcess | undefined;
  let resolver: ChildProcess | undefined;
  try {
    await command('nft', ['-f', ASSETS + '/workload.nft']);
    await command(
      ASSETS + '/attach-workspace',
      [host.dataVolumeId, host.dataVolumeAction],
      120_000
    );
    mounted = true;
    docker = service('dockerd', ['--config-file', ASSETS + '/daemon.json']);
    const dockerDeadline = Date.now() + 30_000;
    while (true) {
      signal.throwIfAborted();
      if (docker.exitCode !== null || Date.now() >= dockerDeadline)
        throw new Error('EC2 Docker unavailable');
      if (
        (await command(
          'docker',
          ['info', '--format', '{{.Driver}} {{.DockerRootDir}}'],
          2_000
        ).catch(() => '')) ===
        'overlay2 ' + STATE + '/workspace/docker'
      )
        break;
      await wait(250, undefined, { signal });
    }

    const imageId = (await readFile(ASSETS + '/image-id', 'utf8')).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('EC2 runtime image unavailable');
    let inspection = await command('docker', ['container', 'inspect', workloadName]).catch(
      () => ''
    );
    if (!inspection && host.dataVolumeAction === 'initialize') {
      await command('docker', ['load', '--input', ASSETS + '/image.tar'], 120_000);
      await command('docker', [
        'create',
        '--name',
        workloadName,
        '--pull',
        'never',
        '--interactive',
        '--init',
        '--user',
        '0',
        '--network',
        'bridge',
        '--dns',
        BRIDGE,
        '--restart',
        'no',
        '--memory',
        String(DOCKER_MEMORY),
        '--memory-swap',
        String(DOCKER_MEMORY),
        '--pids-limit',
        String(DOCKER_PIDS),
        '--cap-drop',
        'NET_RAW',
        '--security-opt',
        'no-new-privileges',
        '--log-driver',
        'none',
        '--tmpfs',
        `/run/kilo-boot:${WORKLOAD_TMPFS}`,
        '--entrypoint',
        '/usr/local/bin/node',
        imageId,
        ...ENTRYPOINT,
      ]);
      inspection = await command('docker', ['container', 'inspect', workloadName]);
    }
    if (!inspectContainer(inspection, imageId)) throw new Error('EC2 runtime layout mismatch');

    stage = 'network';
    const testAccess = await loadEc2TestAccess(RUNTIME + '/test-access.json', host.origin);
    resolver = service('dnsmasq', [
      '--keep-in-foreground',
      '--conf-file=' + ASSETS + '/dnsmasq.conf',
    ]);
    const resolve = createPublicResolver();
    const control = createHostControlPlaneClient({
      ...host,
      fetch: testAccess ? request => testAccess.fetchHost(request, fetch) : fetch,
    });
    const http = createTransparentHttpServer({
      control,
      token: host.token,
      resolve,
      expiresAt: host.expiresAt,
    });
    const certificates = await createHostCertificates(RUNTIME);
    const tls = createTransparentTlsServer({
      control,
      token: host.token,
      resolve,
      expiresAt: host.expiresAt,
      certificate: hostname => certificates.certificate(hostname),
      testAccess,
    });
    try {
      http.server.listen(15080, BRIDGE);
      tls.server.listen(15443, BRIDGE);
      await Promise.all([once(http.server, 'listening'), once(tls.server, 'listening')]);
      const admission = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(0, Math.min(60_000, workload.deadlineAt - Date.now()))),
      ]);
      const current = await (async () => {
        while (true) {
          admission.throwIfAborted();
          try {
            return await control.loadPolicy(host.token, admission);
          } catch {
            // AWS can expose the allocation tag before the owning DO accepts egress.
            await wait(1000, undefined, { signal: admission });
          }
        }
      })();
      if (!resolver.pid || resolver.exitCode !== null) throw new Error('EC2 DNS unavailable');
      if (current.allocationRef !== workload.env.PROVIDER_INSTANCE_ID)
        throw new Error('EC2 host policy scope mismatch');

      stage = 'workload';
      const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      const pending = replayPath + '.next';
      await writeFile(pending, `${host.allocationId} ${bootId}\n`, { mode: 0o600 });
      await rename(pending, replayPath);
      await command('sync', ['-f', STATE]);
      if (signal.aborted || Date.now() >= workload.deadlineAt)
        throw new Error('EC2 launch expired');

      // Pass the wrapper grant only on stdin. The host identity and private key stay here.
      const container = spawn('docker', ['start', '--attach', '--interactive', workloadName], {
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      container.stdin.on('error', () => container.kill());
      const done = once(container, 'exit');
      const expiry = setTimeout(() => signalController.abort(), host.expiresAt - Date.now());
      const stopped = signal.aborted
        ? Promise.resolve('stopping' as const)
        : once(signal, 'abort').then(() => 'stopping' as const);
      try {
        container.stdin.end(
          JSON.stringify({
            ...workload,
            env: {
              ...workload.env,
              KILO_AWS_EGRESS_CA_CERTIFICATE: certificates.authority,
            },
          })
        );
        const result = await Promise.race([done, stopped]);
        if (result !== 'stopping' && result[0] !== 0) console.error('EC2 workspace process exited');
        await command(
          'docker',
          ['stop', '--time', String(STOP_TIMEOUT_SECONDS), workloadName],
          40_000
        );
        clean = true;
      } finally {
        clearTimeout(expiry);
      }
    } finally {
      http.close();
      tls.close();
      await certificates.close();
    }
  } catch {
    console.error('EC2 host failed during ' + stage);
  } finally {
    try {
      await Promise.all([stopService(resolver, 5_000), stopService(docker, 30_000)]);
    } catch {
      clean = false;
    }
    if (mounted) {
      await command(
        ASSETS + '/detach-workspace',
        [clean ? 'clean' : 'unclean', host.allocationId, host.identity.generation],
        30_000
      );
      if (clean) await boot.attestCleanStop(host);
    }
  }
}

void startHost().catch(() => {
  console.error('EC2 host startup failed');
  process.exitCode = 1;
});
