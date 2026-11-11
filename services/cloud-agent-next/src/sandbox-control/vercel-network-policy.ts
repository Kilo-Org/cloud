import type {
  VercelSandboxInjectionRule,
  VercelSandboxNetworkPolicy,
} from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import { EXA_PROXY_PATHS } from '../kilo/runtime-credential-proxy-routes.js';
import { runtimeCredentialProxyFacadeBaseUrl } from '../runtime-credential-proxy.js';

export type VercelCredentialPolicyInput = {
  rootSessionIds: string[];
  organizationId?: string;
  runtimeProxy: {
    members?: Array<{ sessionId: string; kiloSessionId: string; handle: string }>;
    /**
     * Adopted handle strings still valid until their JWT `exp`. An adopted
     * handle is shared by every member root; their rules stay in force so a
     * wrapper that has not yet applied a rotation can still reach the facade.
     * A handle that is not listed keeps only its own member root.
     */
    handles?: readonly string[];
    targets: { backendBaseUrl: string; providerBaseUrl: string; sessionIngestBaseUrl: string };
  };
};

type CredentialRuleInput = {
  target: URL;
  path: NonNullable<VercelSandboxInjectionRule['match']['path']>;
  methods: string[];
  expectedAuthorization: string;
  injectedAuthorization: string;
  organizationId?: string;
};

function invalidPolicy(): never {
  throw new Error('Invalid Vercel credential network policy');
}

function createCredentialRule(input: CredentialRuleInput): VercelSandboxInjectionRule {
  return {
    domain: input.target.hostname,
    headers: {
      authorization: input.injectedAuthorization,
      host: input.target.host,
      ...(input.organizationId === undefined
        ? {}
        : { 'x-kilocode-organizationid': input.organizationId }),
    },
    match: {
      headers: [
        {
          key: { exact: 'authorization' },
          value: { exact: input.expectedAuthorization },
        },
      ],
      path: input.path,
      method: input.methods,
    },
  };
}

function basePath(target: URL): string {
  return target.pathname === '/' ? '' : target.pathname.replace(/\/+$/, '');
}

function runtimeProxyInjectionRules(
  policy: VercelCredentialPolicyInput
): VercelSandboxInjectionRule[] {
  const { runtimeProxy: input, organizationId } = policy;
  const targets = [
    new URL(input.targets.backendBaseUrl),
    new URL(input.targets.providerBaseUrl),
    new URL(input.targets.sessionIngestBaseUrl),
  ];
  if (
    targets.some(
      target =>
        target.protocol !== 'https:' ||
        target.port !== '' ||
        target.username ||
        target.password ||
        target.search ||
        target.hash
    )
  ) {
    invalidPolicy();
  }
  const [backend, provider, ingest] = targets;
  if (
    backend.toString().replace(/\/+$/, '') !== provider.toString().replace(/\/+$/, '') ||
    backend.toString().replace(/\/+$/, '') !== ingest.toString().replace(/\/+$/, '') ||
    runtimeCredentialProxyFacadeBaseUrl(backend.toString()) !==
      backend.toString().replace(/\/+$/, '')
  ) {
    invalidPolicy();
  }
  const rules: VercelSandboxInjectionRule[] = [];
  const add = (target: URL, path: string, methods: string[], authorization: string) =>
    rules.push(
      createCredentialRule({
        target,
        path: { exact: path },
        methods,
        expectedAuthorization: authorization,
        injectedAuthorization: authorization,
      })
    );
  const members = input.members ?? [];
  // A handle that has been adopted is shared by the whole scope, so its rules
  // cover every member root. A per-session handle is not shared and must keep
  // exactly its own member root, as before adoption existed.
  const adoptedHandles = new Set(input.handles ?? []);
  const handles = [...new Set([...members.map(member => member.handle), ...adoptedHandles])];
  const allRoots = [...new Set(policy.rootSessionIds)];
  for (const handle of handles) {
    const authorization = `Bearer ${handle}`;
    const roots = adoptedHandles.has(handle)
      ? allRoots
      : [
          ...new Set(
            members.filter(member => member.handle === handle).map(member => member.kiloSessionId)
          ),
        ];
    for (const path of [
      '/api/user',
      '/api/profile',
      '/api/profile/balance',
      '/api/defaults',
      '/api/users/notifications',
    ])
      add(backend, `${basePath(backend)}${path}`, ['GET'], authorization);
    if (organizationId !== undefined) {
      for (const path of ['models', 'defaults', 'modes']) {
        add(
          backend,
          `${basePath(backend)}/api/organizations/${organizationId}/${path}`,
          ['GET'],
          authorization
        );
      }
      add(
        backend,
        `${basePath(backend)}/api/organizations/${organizationId}/models/validate`,
        ['POST'],
        authorization
      );
    }
    for (const [path, methods] of [
      ['/models', ['GET']],
      ['/models/validate', ['POST']],
      ['/chat/completions', ['POST']],
      ['/messages', ['POST']],
      ['/responses', ['POST']],
      ['/embeddings', ['POST']],
    ] as const) {
      for (const prefix of ['/api/openrouter', '/api/gateway']) {
        add(provider, `${basePath(provider)}${prefix}${path}`, [...methods], authorization);
      }
    }
    if (organizationId !== undefined) {
      for (const prefix of ['/api/openrouter', '/api/gateway']) {
        add(
          provider,
          `${basePath(provider)}${prefix}/organizations/${organizationId}/models`,
          ['GET'],
          authorization
        );
      }
    }
    for (const path of ['/v1/chat/completions', '/v1/responses']) {
      add(provider, `${basePath(provider)}/api/gateway${path}`, ['POST'], authorization);
    }
    add(ingest, `${basePath(ingest)}/api/session`, ['POST'], authorization);
    // Only the opaque handle reaches this facade; its resolver enforces scoped ingestion.
    rules.push(
      createCredentialRule({
        target: ingest,
        path: { startsWith: `${basePath(ingest)}/api/session/` },
        methods: ['POST'],
        expectedAuthorization: authorization,
        injectedAuthorization: authorization,
      })
    );
    // Every member root is served by the shared handle, so each root's
    // ingestion/export/title paths are emitted once per handle.
    for (const sessionId of roots) {
      for (const [suffix, methods] of [
        ['export', ['GET']],
        ['ingest', ['POST']],
        ['title', ['POST']],
      ] as const) {
        add(
          ingest,
          `${basePath(ingest)}/api/session/${sessionId}/${suffix}`,
          [...methods],
          authorization
        );
      }
    }
    for (const path of EXA_PROXY_PATHS) {
      add(backend, `${basePath(backend)}${path}`, ['POST'], authorization);
    }
  }
  return rules;
}

export function findMatchingCredentialInjectionRule(
  rules: readonly VercelSandboxInjectionRule[],
  request: { url: URL; method: string; headers: Headers }
): VercelSandboxInjectionRule | undefined {
  return rules.find(rule => {
    if (
      rule.domain !== request.url.hostname ||
      (rule.match.method && !rule.match.method.includes(request.method))
    ) {
      return false;
    }
    const path = rule.match.path;
    if (
      path &&
      ('exact' in path
        ? path.exact !== request.url.pathname
        : !request.url.pathname.startsWith(path.startsWith))
    ) {
      return false;
    }
    return rule.match.headers.every(
      matcher => request.headers.get(matcher.key.exact) === matcher.value.exact
    );
  });
}

export function buildVercelCredentialNetworkPolicy(input: VercelCredentialPolicyInput): {
  allowedDomains: string[];
  injectionRules: VercelSandboxInjectionRule[];
} {
  const injectionRules = runtimeProxyInjectionRules(input);
  return {
    allowedDomains: [
      ...new Set([
        ...injectionRules.map(rule => rule.domain),
        new URL(input.runtimeProxy.targets.backendBaseUrl).hostname,
      ]),
      '*',
    ],
    injectionRules,
  };
}

export function buildVercelTransformNetworkPolicy(
  allowedDomains: readonly string[],
  injectionRules: readonly VercelSandboxInjectionRule[]
): VercelSandboxNetworkPolicy {
  const allow: VercelSandboxNetworkPolicy['allow'] = {};
  for (const domain of allowedDomains) {
    if (domain !== '*') allow[domain] = [];
  }
  for (const { domain, match, headers } of injectionRules) {
    (allow[domain] ??= []).push({ match, transform: [{ headers }] });
  }
  if (allowedDomains.includes('*')) allow['*'] = [];
  return { allow };
}
