import { containedKiloSessionIdSchema } from '@kilocode/session-ingest-contracts';
import type {
  VercelSandboxInjectionRule,
  VercelSandboxNetworkPolicy,
} from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import { deriveKiloSandboxTargets, type KiloSandboxTargets } from '../kilo/kilo-targets.js';

export type VercelCredentialPolicyInput = {
  kilo?: {
    token: string;
    placeholder: string;
    targets: KiloSandboxTargets;
    rootSessionIds: string[];
    organizationId?: string;
    runtimeProxy?: {
      handle?: string;
      targets: { backendBaseUrl: string; providerBaseUrl: string; sessionIngestBaseUrl: string };
    };
  };
  github?: {
    token: string;
    placeholder: string;
    repository: string;
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

function validateCredential(token: string, placeholder: string): void {
  if (
    token.length === 0 ||
    placeholder.length === 0 ||
    token === placeholder ||
    /[\r\n]/.test(token) ||
    /[\r\n]/.test(placeholder)
  ) {
    invalidPolicy();
  }
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

function providerPrefixes(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  const apiIndex = segments.lastIndexOf('api');
  const prefix = apiIndex < 0 ? segments : segments.slice(0, apiIndex);
  return ['openrouter', 'gateway'].map(route => `/${[...prefix, 'api', route].join('/')}/`);
}

function providerCatalogBasePath(provider: URL, organizationId: string | undefined): string {
  const path = basePath(provider);
  const segments = path.split('/').filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    if (segments[index] === 'api' && segments[index + 1] === 'organizations') {
      const embeddedOrganizationId = segments[index + 2];
      if (!embeddedOrganizationId || embeddedOrganizationId !== organizationId) invalidPolicy();
    }
  }

  if (organizationId !== undefined) {
    if (path.includes('/api/organizations/')) return path;
    if (path.endsWith('/api')) return `${path}/organizations/${organizationId}`;
    return `${path}/api/organizations/${organizationId}`;
  }

  if (provider.toString().includes('/openrouter')) return path;
  if (path.endsWith('/api')) return `${path}/openrouter`;
  return `${path}/api/openrouter`;
}

export function buildKiloCredentialInjectionRules(
  input: NonNullable<VercelCredentialPolicyInput['kilo']>,
  options?: { requireHttps?: boolean }
): VercelSandboxInjectionRule[] {
  validateCredential(input.token, input.placeholder);
  if (!Array.isArray(input.rootSessionIds) || input.rootSessionIds.length === 0) invalidPolicy();
  const rootSessionIds = [...new Set(input.rootSessionIds)];
  if (rootSessionIds.some(id => !containedKiloSessionIdSchema.safeParse(id).success))
    invalidPolicy();
  if (
    input.organizationId !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.organizationId)
  ) {
    invalidPolicy();
  }

  const validatedTargets = deriveKiloSandboxTargets(
    {
      KILOCODE_BACKEND_BASE_URL: input.targets.backendBaseUrl,
      KILO_OPENROUTER_BASE: input.targets.providerBaseUrl,
      KILO_SESSION_INGEST_URL: input.targets.sessionIngestBaseUrl,
    },
    '',
    { requireHttps: options?.requireHttps !== false }
  );
  if (!validatedTargets.success) invalidPolicy();

  const backend = new URL(validatedTargets.targets.backendBaseUrl);
  const provider = new URL(validatedTargets.targets.providerBaseUrl);
  const ingest = new URL(validatedTargets.targets.sessionIngestBaseUrl);
  const catalogBasePath = providerCatalogBasePath(provider, input.organizationId);
  const expectedAuthorization = `Bearer ${input.placeholder}`;
  const injectedAuthorization = `Bearer ${input.token}`;
  const rules: VercelSandboxInjectionRule[] = [];
  const addRule = (
    target: URL,
    path: NonNullable<VercelSandboxInjectionRule['match']['path']>,
    methods: string[],
    authorization = injectedAuthorization
  ) => {
    rules.push(
      createCredentialRule({
        target,
        path,
        methods,
        expectedAuthorization,
        injectedAuthorization: authorization,
        organizationId: input.organizationId ?? '',
      })
    );
  };

  const sessionCollection = `${basePath(ingest)}/api/session`;
  for (const rootSessionId of rootSessionIds) {
    const sessionPrefix = `${sessionCollection}/${rootSessionId}`;
    addRule(ingest, { exact: `${sessionPrefix}/export` }, ['GET']);
    addRule(ingest, { exact: `${sessionPrefix}/ingest` }, ['POST']);
  }

  const modelPrefixes = providerPrefixes(basePath(provider));
  const catalogPaths = [`${catalogBasePath}/models`, `${catalogBasePath}/models/validate`];
  const sessionNamespace = `${sessionCollection}/`;
  const requiresSessionShadows =
    provider.hostname === ingest.hostname &&
    (modelPrefixes.some(
      prefix =>
        sessionCollection.startsWith(prefix) ||
        sessionNamespace.startsWith(prefix) ||
        prefix.startsWith(sessionNamespace)
    ) ||
      catalogPaths.some(path => path === sessionCollection || path.startsWith(sessionNamespace)));
  if (requiresSessionShadows) {
    addRule(ingest, { exact: sessionCollection }, ['GET', 'POST'], expectedAuthorization);
    addRule(ingest, { startsWith: sessionNamespace }, ['GET', 'POST'], expectedAuthorization);
  }

  const backendApiPath = `${basePath(backend)}/api`;
  for (const suffix of ['user', 'profile', 'profile/balance', 'defaults', 'users/notifications']) {
    addRule(backend, { exact: `${backendApiPath}/${suffix}` }, ['GET']);
  }

  if (input.organizationId !== undefined) {
    const organizationPath = `${backendApiPath}/organizations/${input.organizationId}`;
    for (const suffix of ['models', 'defaults', 'modes']) {
      addRule(backend, { exact: `${organizationPath}/${suffix}` }, ['GET']);
    }
    addRule(backend, { exact: `${organizationPath}/models/validate` }, ['POST']);
  } else {
    addRule(backend, { exact: `${backendApiPath}/openrouter/models/validate` }, ['POST']);
  }

  addRule(provider, { exact: `${catalogBasePath}/models` }, ['GET']);
  addRule(provider, { exact: `${catalogBasePath}/models/validate` }, ['POST']);

  for (const prefix of modelPrefixes) {
    addRule(provider, { startsWith: prefix }, ['GET', 'POST']);
  }
  return rules;
}

function runtimeProxyInjectionRules(
  kilo: NonNullable<VercelCredentialPolicyInput['kilo']>,
  organizationId: string | undefined
): VercelSandboxInjectionRule[] {
  const input = kilo.runtimeProxy;
  if (!input?.handle) return [];
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
  const authorization = `Bearer ${input.handle}`;
  const rules: VercelSandboxInjectionRule[] = [];
  const add = (target: URL, path: string, methods: string[]) =>
    rules.push(
      createCredentialRule({
        target,
        path: { exact: path },
        methods,
        expectedAuthorization: authorization,
        injectedAuthorization: authorization,
      })
    );
  for (const path of [
    '/api/user',
    '/api/profile',
    '/api/profile/balance',
    '/api/defaults',
    '/api/users/notifications',
  ]) {
    add(backend, `${basePath(backend)}${path}`, ['GET']);
  }
  if (organizationId !== undefined) {
    for (const path of ['models', 'defaults', 'modes']) {
      add(backend, `${basePath(backend)}/api/organizations/${organizationId}/${path}`, ['GET']);
    }
    add(backend, `${basePath(backend)}/api/organizations/${organizationId}/models/validate`, [
      'POST',
    ]);
  }
  for (const [path, methods] of [
    ['/models', ['GET']],
    ['/models/validate', ['POST']],
    ['/chat/completions', ['POST']],
    ['/messages', ['POST']],
    ['/responses', ['POST']],
    ['/embeddings', ['POST']],
  ] as const) {
    add(provider, `${basePath(provider)}${path}`, [...methods]);
  }
  if (organizationId !== undefined) {
    add(provider, `${basePath(provider)}/api/organizations/${organizationId}/models`, ['GET']);
  }
  add(ingest, `${basePath(ingest)}/api/session`, ['POST']);
  for (const sessionId of kilo.rootSessionIds) {
    for (const [suffix, methods] of [
      ['export', ['GET']],
      ['ingest', ['POST']],
      ['title', ['POST']],
    ] as const) {
      add(ingest, `${basePath(ingest)}/api/session/${sessionId}/${suffix}`, [...methods]);
    }
  }
  return rules;
}

function githubInjectionRules(
  input: NonNullable<VercelCredentialPolicyInput['github']>
): VercelSandboxInjectionRule[] {
  validateCredential(input.token, input.placeholder);
  const segments = input.repository.split('/');
  if (
    segments.length !== 2 ||
    segments.some(
      segment => !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..'
    )
  ) {
    invalidPolicy();
  }

  const repositoryPath = input.repository;
  const github = new URL('https://github.com');
  const githubApi = new URL('https://api.github.com');
  const placeholderBasic = btoa(`x-access-token:${input.placeholder}`);
  const tokenBasic = btoa(`x-access-token:${input.token}`);
  const rules = [
    createCredentialRule({
      target: github,
      path: { startsWith: `/${repositoryPath}.git/` },
      methods: ['GET', 'POST'],
      expectedAuthorization: `Basic ${placeholderBasic}`,
      injectedAuthorization: `Basic ${tokenBasic}`,
    }),
  ];

  const apiPath = `/repos/${repositoryPath}`;
  for (const operation of ['registration-token', 'remove-token', 'generate-jitconfig']) {
    for (const scheme of ['Bearer', 'token']) {
      const authorization = `${scheme} ${input.placeholder}`;
      rules.push(
        createCredentialRule({
          target: githubApi,
          path: { exact: `${apiPath}/actions/runners/${operation}` },
          methods: ['POST'],
          expectedAuthorization: authorization,
          injectedAuthorization: authorization,
        })
      );
    }
  }

  for (const path of [{ exact: apiPath }, { startsWith: `${apiPath}/` }]) {
    for (const scheme of ['Bearer', 'token']) {
      rules.push(
        createCredentialRule({
          target: githubApi,
          path,
          methods: ['GET', 'HEAD', 'POST', 'PATCH'],
          expectedAuthorization: `${scheme} ${input.placeholder}`,
          injectedAuthorization: `Bearer ${input.token}`,
        })
      );
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

export function buildVercelCredentialNetworkPolicy(
  input: VercelCredentialPolicyInput
): VercelSandboxNetworkPolicy {
  if (
    input.kilo !== undefined &&
    input.github !== undefined &&
    input.kilo.placeholder === input.github.placeholder
  ) {
    invalidPolicy();
  }

  const injectionRules = [
    ...(input.kilo === undefined
      ? []
      : input.kilo.runtimeProxy
        ? runtimeProxyInjectionRules(input.kilo, input.kilo.organizationId)
        : buildKiloCredentialInjectionRules(input.kilo)),
    ...(input.github === undefined ? [] : githubInjectionRules(input.github)),
  ];

  return {
    mode: 'custom',
    allowedDomains: [
      ...new Set([
        ...injectionRules.map(rule => rule.domain),
        ...(input.kilo?.runtimeProxy
          ? [new URL(input.kilo.runtimeProxy.targets.backendBaseUrl).hostname]
          : []),
      ]),
      '*',
    ],
    injectionRules,
  };
}
