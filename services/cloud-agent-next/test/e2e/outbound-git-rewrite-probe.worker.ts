/// <reference path="./outbound-git-rewrite-probe.worker-configuration.d.ts" />

import { ContainerProxy, getSandbox, Sandbox } from '@cloudflare/sandbox';

const SYNTHETIC_GIT_HOST = 'rewrite-git.invalid';
const SYNTHETIC_AUTH_RETAINED_HOST = 'rewrite-git-retain-auth.invalid';
const SYNTHETIC_REPOSITORY_PATH = '/octocat/Hello-World.git';
const PUBLIC_REPOSITORY_URL = 'https://github.com/octocat/Hello-World.git';
const PLACEHOLDER_AUTHORIZATION = 'Basic eC1hY2Nlc3MtdG9rZW46c2FuZGJveC1wbGFjZWhvbGRlcg==';
const REF_OUTPUT = /^[0-9a-f]{40}\t(?:HEAD|refs\/heads\/(?:master|main))$/m;
const AUTH_REJECTION =
  /Invalid username or token|Authentication failed|could not read Username.*terminal prompts disabled/;
const PROBE_ID = /^probe-[0-9a-f-]{36}$/;

type ProbeProtocol = 'https' | 'http';
type ForwardingMode = 'strip' | 'retain';

type ProbeResult = {
  ok: boolean;
  protocol: ProbeProtocol;
  expectedSuccess: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
};

export { ContainerProxy };

function createGitHandler(mode: ForwardingMode) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('unsupported method for ls-remote probe', { status: 405 });
    }
    if (request.headers.get('Authorization') !== PLACEHOLDER_AUTHORIZATION) {
      return new Response('expected placeholder authorization was not received', { status: 401 });
    }

    const source = new URL(request.url);
    if (!source.pathname.startsWith(SYNTHETIC_REPOSITORY_PATH)) {
      return new Response('unexpected repository path', { status: 404 });
    }

    const target = new URL(PUBLIC_REPOSITORY_URL);
    target.pathname = `${target.pathname}${source.pathname.slice(SYNTHETIC_REPOSITORY_PATH.length)}`;
    target.search = source.search;

    const headers = new Headers(request.headers);
    headers.delete('Host');
    if (mode === 'strip') {
      headers.delete('Authorization');
    }

    const response = await fetch(target, { method: request.method, headers, redirect: 'follow' });
    return new Response(response.body, response);
  };
}

export class OutboundGitRewriteProbeSandbox extends Sandbox<Env> {
  enableInternet = true;
  interceptHttps = true;
}

OutboundGitRewriteProbeSandbox.outboundByHost = {
  [SYNTHETIC_GIT_HOST]: createGitHandler('strip'),
  [SYNTHETIC_AUTH_RETAINED_HOST]: createGitHandler('retain'),
};

function parseProbeId(url: URL): string | null {
  const probeId = url.searchParams.get('probeId');
  return probeId && PROBE_ID.test(probeId) ? probeId : null;
}

function getProbeSandbox(env: Env, probeId: string) {
  return getSandbox(env.PROBE_SANDBOX, probeId, { normalizeId: true, sleepAfter: '1m' });
}

async function runGitProbe(
  protocol: ProbeProtocol,
  mode: ForwardingMode,
  env: Env,
  probeId: string
): Promise<Response> {
  const expectedSuccess = mode === 'strip';
  const session = await getProbeSandbox(env, probeId).createSession({
    name: `outbound-git-rewrite-${protocol}-${mode}`,
    env: { PROBE_AUTHORIZATION: PLACEHOLDER_AUTHORIZATION },
    commandTimeoutMs: 120_000,
  });
  const host = mode === 'retain' ? SYNTHETIC_AUTH_RETAINED_HOST : SYNTHETIC_GIT_HOST;
  const remote = `${protocol}://${host}${SYNTHETIC_REPOSITORY_PATH}`;
  const command = `GIT_TERMINAL_PROMPT=0 git -c protocol.version=0 -c http.extraHeader=\"Authorization: $PROBE_AUTHORIZATION\" ls-remote '${remote}' HEAD refs/heads/master refs/heads/main`;
  const result = await session.exec(command);
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const succeedsWithRefOutput = result.success && REF_OUTPUT.test(stdout);
  const ok = expectedSuccess
    ? succeedsWithRefOutput
    : !result.success && AUTH_REJECTION.test(stderr);
  const payload: ProbeResult = {
    ok,
    protocol,
    expectedSuccess,
    exitCode: result.exitCode,
    stdout,
    stderr,
  };
  return Response.json(payload, { status: ok ? 200 : 502 });
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

    try {
      if (url.pathname === '/cleanup') {
        const sandbox = getProbeSandbox(env, probeId);
        const sandboxDoId = env.PROBE_SANDBOX.idFromName(probeId).toString();
        await sandbox.destroy();
        return Response.json({ ok: true, sandboxDoId });
      }
      if (url.pathname === '/probe') {
        const protocol = url.searchParams.get('protocol');
        const mode = url.searchParams.get('mode') ?? 'strip';
        if (protocol !== 'http' && protocol !== 'https') {
          return Response.json({ error: 'protocol must be https or http' }, { status: 400 });
        }
        if (mode !== 'strip' && mode !== 'retain') {
          return Response.json({ error: 'mode must be strip or retain' }, { status: 400 });
        }
        return await runGitProbe(protocol, mode, env, probeId);
      }
      return new Response('not found', { status: 404 });
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  },
} satisfies { fetch(request: Request, env: Env): Promise<Response> };
