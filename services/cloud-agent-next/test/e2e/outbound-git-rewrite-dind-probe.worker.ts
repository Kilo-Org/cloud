/// <reference path="./outbound-git-rewrite-dind-probe.worker-configuration.d.ts" />

import { ContainerProxy, getSandbox, Sandbox, type ExecutionSession } from '@cloudflare/sandbox';

const SYNTHETIC_GIT_HOST = 'rewrite-git.invalid';
const SYNTHETIC_AUTH_RETAINED_HOST = 'rewrite-git-retain-auth.invalid';
const SYNTHETIC_REPOSITORY_PATH = '/octocat/Hello-World.git';
const PUBLIC_REPOSITORY_URL = 'https://github.com/octocat/Hello-World.git';
const PLACEHOLDER_AUTHORIZATION = 'Basic eC1hY2Nlc3MtdG9rZW46c2FuZGJveC1wbGFjZWhvbGRlcg==';
const NESTED_GIT_IMAGE =
  'alpine/git@sha256:8786a6a02273827d0aa039d174aacd5e017fcce9aba0af62596d991970cab01a';
const OUTER_TRUSTED_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
const NESTED_TRUSTED_CA_BUNDLE = '/probe-ca-certificates.crt';
const REF_OUTPUT = /^[0-9a-f]{40}\t(?:HEAD|refs\/heads\/(?:master|main))$/m;
const TLS_REJECTION =
  /server certificate verification failed|SSL certificate problem|certificate verify failed|self-signed certificate in certificate chain/i;
const AUTH_REJECTION =
  /Invalid username or token|Authentication failed|could not read Username.*terminal prompts disabled/;
const PROBE_ID = /^probe-[0-9a-f-]{36}$/;

const DOCKER_SOCKET_COMMAND =
  'if [ -S /run/user/1000/docker.sock ]; then printf /run/user/1000/docker.sock; elif [ -S /var/run/docker.sock ]; then printf /var/run/docker.sock; fi';

const DOCKER_READY_COMMAND = `socket="$(${DOCKER_SOCKET_COMMAND})"; if [ -z "$socket" ]; then printf 'Docker socket not found' >&2; false; else DOCKER_HOST="unix://$socket" docker version --format '{{.Server.Version}}'; fi`;

type ProbeProtocol = 'https' | 'http';
type ForwardingMode = 'strip' | 'retain';
type CaPropagation = 'explicit' | 'none';
type ExpectedOutcome = 'success' | 'tls-rejection' | 'auth-rejection';

type ProbeResult = {
  ok: boolean;
  protocol: ProbeProtocol;
  caPropagation: CaPropagation;
  expectedOutcome: ExpectedOutcome;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
};

export { ContainerProxy };

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function handleProbeOutbound(request: Request): Promise<Response> {
  const source = new URL(request.url);
  if (source.hostname !== SYNTHETIC_GIT_HOST && source.hostname !== SYNTHETIC_AUTH_RETAINED_HOST) {
    return fetch(request);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('unsupported method for ls-remote probe', { status: 405 });
  }
  if (request.headers.get('Authorization') !== PLACEHOLDER_AUTHORIZATION) {
    return new Response('expected placeholder authorization was not received', { status: 401 });
  }
  if (!source.pathname.startsWith(SYNTHETIC_REPOSITORY_PATH)) {
    return new Response('unexpected repository path', { status: 404 });
  }

  const target = new URL(PUBLIC_REPOSITORY_URL);
  target.pathname = `${target.pathname}${source.pathname.slice(SYNTHETIC_REPOSITORY_PATH.length)}`;
  target.search = source.search;

  const headers = new Headers(request.headers);
  headers.delete('Host');
  if (source.hostname === SYNTHETIC_GIT_HOST) {
    headers.delete('Authorization');
  }

  const response = await fetch(target, { method: request.method, headers, redirect: 'follow' });
  return new Response(response.body, response);
}

export class OutboundGitRewriteDindProbeSandbox extends Sandbox<Env> {
  enableInternet = true;
  interceptHttps = true;
}

OutboundGitRewriteDindProbeSandbox.outbound = handleProbeOutbound;

function parseProbeId(url: URL): string | null {
  const probeId = url.searchParams.get('probeId');
  return probeId && PROBE_ID.test(probeId) ? probeId : null;
}

function getProbeSandbox(env: Env, probeId: string) {
  return getSandbox(env.PROBE_SANDBOX, probeId, { normalizeId: true, sleepAfter: '1m' });
}

async function waitForDocker(session: ExecutionSession): Promise<void> {
  const deadline = Date.now() + 60_000;
  let stderr = '';
  while (Date.now() < deadline) {
    const result = await session.exec(DOCKER_READY_COMMAND);
    if (result.success) return;
    stderr = result.stderr.trim();
    await scheduler.wait(500);
  }
  throw new Error(`nested dockerd did not become ready: ${stderr}`);
}

function expectedOutcome(
  protocol: ProbeProtocol,
  mode: ForwardingMode,
  caPropagation: CaPropagation
): ExpectedOutcome {
  if (protocol === 'https' && caPropagation === 'none') return 'tls-rejection';
  return mode === 'retain' ? 'auth-rejection' : 'success';
}

function nestedContainerName(
  probeId: string,
  protocol: ProbeProtocol,
  outcome: ExpectedOutcome
): string {
  return `${probeId}-${protocol}-${outcome}`;
}

function nestedDockerCommand(
  probeId: string,
  protocol: ProbeProtocol,
  mode: ForwardingMode,
  caPropagation: CaPropagation
): string {
  const host = mode === 'retain' ? SYNTHETIC_AUTH_RETAINED_HOST : SYNTHETIC_GIT_HOST;
  const remote = `${protocol}://${host}${SYNTHETIC_REPOSITORY_PATH}`;
  const outcome = expectedOutcome(protocol, mode, caPropagation);
  const caMount =
    caPropagation === 'explicit'
      ? ` --volume ${shellEscape(`${OUTER_TRUSTED_CA_BUNDLE}:${NESTED_TRUSTED_CA_BUNDLE}:ro`)} --env GIT_SSL_CAINFO=${shellEscape(NESTED_TRUSTED_CA_BUNDLE)}`
      : '';
  const gitCommand = `git -c protocol.version=0 -c http.extraHeader=\"Authorization: $PROBE_AUTHORIZATION\" ls-remote ${shellEscape(remote)} HEAD refs/heads/master refs/heads/main`;
  return `socket="$(${DOCKER_SOCKET_COMMAND})"; if [ -z "$socket" ]; then printf 'Docker socket not found' >&2; false; else DOCKER_HOST="unix://$socket" docker run --pull=missing --rm --name ${shellEscape(nestedContainerName(probeId, protocol, outcome))} --label ${shellEscape(`kilo.outbound-git-rewrite-dind-probe=${probeId}`)} --network=host --env GIT_TERMINAL_PROMPT=0 --env PROBE_AUTHORIZATION=${shellEscape(PLACEHOLDER_AUTHORIZATION)}${caMount} --entrypoint sh ${shellEscape(NESTED_GIT_IMAGE)} -c ${shellEscape(gitCommand)}; fi`;
}

async function runGitProbe(
  protocol: ProbeProtocol,
  mode: ForwardingMode,
  caPropagation: CaPropagation,
  env: Env,
  probeId: string
): Promise<Response> {
  const outcome = expectedOutcome(protocol, mode, caPropagation);
  const session = await getProbeSandbox(env, probeId).createSession({
    name: `outbound-git-rewrite-dind-${protocol}-${outcome}`,
    commandTimeoutMs: 180_000,
  });
  await waitForDocker(session);
  const result = await session.exec(nestedDockerCommand(probeId, protocol, mode, caPropagation), {
    timeout: 180_000,
  });
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const ok =
    outcome === 'success'
      ? result.success && REF_OUTPUT.test(stdout)
      : !result.success &&
        (outcome === 'tls-rejection' ? TLS_REJECTION : AUTH_REJECTION).test(stderr);
  const payload: ProbeResult = {
    ok,
    protocol,
    caPropagation,
    expectedOutcome: outcome,
    exitCode: result.exitCode,
    stdout,
    stderr,
  };
  return Response.json(payload, { status: ok ? 200 : 502 });
}

async function removeNestedContainers(env: Env, probeId: string): Promise<void> {
  const session = await getProbeSandbox(env, probeId).createSession({
    name: 'outbound-git-rewrite-dind-cleanup',
    commandTimeoutMs: 30_000,
  });
  await waitForDocker(session);
  const label = shellEscape(`label=kilo.outbound-git-rewrite-dind-probe=${probeId}`);
  const cleanupCommand = `socket="$(${DOCKER_SOCKET_COMMAND})"; if [ -z "$socket" ]; then printf 'Docker socket not found' >&2; false; else ids="$(DOCKER_HOST="unix://$socket" docker ps -aq --filter ${label})"; [ -z "$ids" ] || DOCKER_HOST="unix://$socket" docker rm -f $ids; remaining="$(DOCKER_HOST="unix://$socket" docker ps -aq --filter ${label})"; if [ -n "$remaining" ]; then printf 'Invocation-specific nested containers remain after cleanup: %s' "$remaining" >&2; false; fi; fi`;
  const result = await session.exec(cleanupCommand, { timeout: 30_000 });
  if (!result.success) {
    throw new Error(
      `could not remove invocation-specific nested containers: ${result.stderr.trim()}`
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true });
    }

    const probeId = parseProbeId(url);
    if (!probeId) {
      return Response.json({ error: 'valid probeId is required' }, { status: 400 });
    }

    const sandboxDoId = env.PROBE_SANDBOX.idFromName(probeId).toString();
    if (url.pathname === '/sandbox-id') {
      return Response.json({ sandboxDoId });
    }

    try {
      if (url.pathname === '/cleanup') {
        const sandbox = getProbeSandbox(env, probeId);
        await removeNestedContainers(env, probeId);
        await sandbox.destroy();
        return Response.json({ ok: true, sandboxDoId });
      }
      if (url.pathname === '/probe') {
        const protocol = url.searchParams.get('protocol');
        const mode = url.searchParams.get('mode') ?? 'strip';
        const caPropagation = url.searchParams.get('ca') ?? 'explicit';
        if (protocol !== 'http' && protocol !== 'https') {
          return Response.json({ error: 'protocol must be https or http' }, { status: 400 });
        }
        if (mode !== 'strip' && mode !== 'retain') {
          return Response.json({ error: 'mode must be strip or retain' }, { status: 400 });
        }
        if (caPropagation !== 'explicit' && caPropagation !== 'none') {
          return Response.json({ error: 'ca must be explicit or none' }, { status: 400 });
        }
        return await runGitProbe(protocol, mode, caPropagation, env, probeId);
      }
      return new Response('not found', { status: 404 });
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  },
} satisfies ExportedHandler<Env>;
