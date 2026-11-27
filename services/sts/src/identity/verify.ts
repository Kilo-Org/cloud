import {
  AttestedGithubRunSchema,
  type AttestedGithubRun,
  type StsEnvironment,
  type WorkloadName,
} from '@kilocode/sts-contracts';
import {
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  errors,
  jwtVerify,
  type JWTPayload,
  type RemoteJWKSet,
} from 'jose';
import { z } from 'zod';
import { PROVIDER_FETCH_TIMEOUT_MS } from '../constants';
import {
  JobWorkflowRefSchema,
  VERCEL_ISSUER_PREFIX,
  githubLegacySubject,
  githubSubject,
  vercelStsEnvironments,
  type GithubIdentity,
  type Policy,
  type PolicyIdentity,
  type VercelEnvironment,
} from '../policy/schema';

const DiscoverySchema = z.object({
  issuer: z.string().min(1),
  jwks_uri: z.url(),
});

export type IdentityProvider = 'fly' | 'github' | 'vercel';
export type DeniedReason = 'identity_rejected' | 'unknown_workload' | 'environment_mismatch';

/**
 * Who a refused token came from, set only after its signature, issuer, audience and lifetime
 * verified. `actor` is the policy's workload when the token named one, otherwise the provider's
 * stable id; `claims` are the provider's stable ids, never the token.
 */
export type VerifiedSubject = {
  provider: IdentityProvider;
  actor: string;
  claims: Record<string, string>;
};

export type VerifyOutcome =
  | {
      status: 'verified';
      workload: WorkloadName;
      provider: IdentityProvider;
      /** The provider token's own `exp` and `iat`, in seconds; a minted token never outlives it. */
      attestationExp: number;
      attestationIat: number;
      /** A GitHub token's `job_workflow_ref`, `run_id` and `run_attempt`, for the delivery row only; refusals omit them. */
      run: GithubRun | null;
      /**
       * A GitHub token's verified repository, environment, ref, sha, event and run claims; set only
       * by a verifier built with `githubClaims: true` (the migration attestation), else null.
       */
      github: AttestedGithubRun | null;
    }
  | { status: 'denied'; reason: DeniedReason; subject?: VerifiedSubject }
  /** A provider's discovery document or key set could not be fetched; the caller retries. */
  | { status: 'unavailable' };

const FLY_ISSUER_PREFIX = 'https://oidc.fly.io/';
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
/** Every provider signs with RS256; their discovery documents say so. */
const ALGORITHMS = ['RS256'];
const CLOCK_TOLERANCE_SECONDS = 60;
/** A Fly org slug or a Vercel team slug; Vercel's team id issuer form (`team_...`) is refused. */
const ISSUER_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A provider endpoint failed: network error, timeout, non-200, or a body that is not JSON. */
class ProviderUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ProviderUnavailableError';
  }
}

function issuerFor(identity: PolicyIdentity): string | null {
  switch (identity.kind) {
    case 'worker-binding':
      return null;
    case 'fly-oidc':
      return `${FLY_ISSUER_PREFIX}${identity.org}`;
    case 'github-oidc':
      return GITHUB_ISSUER;
    case 'vercel-oidc':
      return `${VERCEL_ISSUER_PREFIX}${identity.teamSlug}`;
  }
}

function claim(payload: JWTPayload, name: string): string | null {
  const value = payload[name];
  return typeof value === 'string' ? value : null;
}

/** GitHub's run ids are decimal; anything else (or longer than 20 digits) is left out. */
const RUN_NUMBER = /^[0-9]{1,20}$/;

/**
 * The run a verified GitHub token came from; bounded flat strings for the delivery row.
 * `BundleDO.getBundle` parses it, because RPC hands over whatever its caller sent.
 */
export const GithubRunSchema = z.strictObject({
  jobWorkflowRef: JobWorkflowRefSchema,
  runId: z.string().regex(RUN_NUMBER),
  runAttempt: z.string().regex(RUN_NUMBER).optional(),
});
export type GithubRun = z.infer<typeof GithubRunSchema>;

/** Runs once `job_workflow_ref` equals a listed entry, which the policy schema bounds. */
function githubRun(payload: JWTPayload): GithubRun | null {
  const jobWorkflowRef = claim(payload, 'job_workflow_ref');
  const runId = claim(payload, 'run_id');
  if (jobWorkflowRef === null || runId === null || !RUN_NUMBER.test(runId)) return null;
  const run = { jobWorkflowRef, runId };
  const runAttempt = claim(payload, 'run_attempt');
  return runAttempt !== null && RUN_NUMBER.test(runAttempt) ? { ...run, runAttempt } : run;
}

/** The claims `attestGithubRun` returns, or null when one is missing or malformed. */
function attestedGithubRun(payload: JWTPayload): AttestedGithubRun | null {
  const parsed = AttestedGithubRunSchema.safeParse({
    repositoryId: claim(payload, 'repository_id'),
    repositoryOwnerId: claim(payload, 'repository_owner_id'),
    environment: claim(payload, 'environment'),
    ref: claim(payload, 'ref'),
    sha: claim(payload, 'sha'),
    eventName: claim(payload, 'event_name'),
    jobWorkflowRef: claim(payload, 'job_workflow_ref'),
    runId: claim(payload, 'run_id'),
    runAttempt: claim(payload, 'run_attempt'),
  });
  return parsed.success ? parsed.data : null;
}

function isKnownProviderIssuer(issuer: string): boolean {
  if (issuer === GITHUB_ISSUER) return true;
  if (issuer.startsWith(VERCEL_ISSUER_PREFIX)) {
    return ISSUER_SLUG.test(issuer.slice(VERCEL_ISSUER_PREFIX.length));
  }
  return (
    issuer.startsWith(FLY_ISSUER_PREFIX) && ISSUER_SLUG.test(issuer.slice(FLY_ISSUER_PREFIX.length))
  );
}

/** Only called for an issuer some policy names, so anything else is a Fly org issuer. */
function providerFor(issuer: string): IdentityProvider {
  if (issuer === GITHUB_ISSUER) return 'github';
  return issuer.startsWith(VERCEL_ISSUER_PREFIX) ? 'vercel' : 'fly';
}

const STABLE_CLAIMS: Record<IdentityProvider, readonly string[]> = {
  // `run_id` and the other per-run claims stay out: they would make each refusal its own row. So
  // does `sub`, which a customized template can build from them; `sub_format` stands in for it.
  github: [
    'repository_id',
    'repository_owner_id',
    'repository',
    'environment',
    'ref',
    'event_name',
    'job_workflow_ref',
  ],
  fly: ['org_id', 'org_name', 'app_id', 'app_name', 'machine_id'],
  // Ids only: team and project names can be renamed and never authorize. `user_id` names the
  // person whose `vercel env pull` or `vercel dev` token was refused.
  vercel: ['owner_id', 'project_id', 'environment', 'custom_environment_id', 'user_id'],
};

/** GitHub's default subject: a repository, then the job's environment, its ref, or a pull request. */
const GITHUB_DEFAULT_SUBJECT = /^repo:([^:]+):(environment|ref|pull_request)(?::[^:]+)?$/;
const GITHUB_IMMUTABLE_REPOSITORY = /^[A-Za-z0-9-]+@[0-9]+\/[A-Za-z0-9._-]+@[0-9]+$/;
const GITHUB_NAME_ONLY_REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * The shape of a GitHub token's `sub`, one of a fixed set (`immutable:environment`,
 * `name-only:ref`, `custom`, ...), never the subject itself: a customized template can carry
 * per-run claims such as `run_id`, which would make each refusal its own row.
 */
function githubSubjectFormat(subject: string | null): string {
  if (subject === null) return 'absent';
  const match = GITHUB_DEFAULT_SUBJECT.exec(subject);
  const repository = match?.[1] ?? '';
  const context = match?.[2];
  if (context === undefined) return 'custom';
  if (GITHUB_IMMUTABLE_REPOSITORY.test(repository)) return `immutable:${context}`;
  if (GITHUB_NAME_ONLY_REPOSITORY.test(repository)) return `name-only:${context}`;
  return 'custom';
}

function verifiedSubject(
  provider: IdentityProvider,
  payload: JWTPayload,
  workload: string | null
): VerifiedSubject {
  const claims: Record<string, string> = {};
  for (const name of STABLE_CLAIMS[provider]) {
    const value = claim(payload, name);
    if (value !== null) claims[name] = value.slice(0, 200);
  }
  if (provider === 'github') claims.sub_format = githubSubjectFormat(claim(payload, 'sub'));
  return { provider, actor: workload ?? providerId(provider, claims), claims };
}

function providerId(provider: IdentityProvider, claims: Record<string, string>): string {
  switch (provider) {
    case 'github':
      return `github:${claims.repository_id ?? 'unknown'}`;
    case 'fly':
      return `fly:${claims.org_id ?? 'unknown'}/${claims.app_id ?? 'unknown'}`;
    case 'vercel':
      return `vercel:${claims.owner_id ?? 'unknown'}/${claims.project_id ?? 'unknown'}`;
  }
}

/**
 * A Vercel token's `sub` is `owner:<team slug>:project:<project name>:environment:<environment>`
 * (https://vercel.com/docs/oidc/reference). The names only have to agree with the token's own
 * claims and issuer; the ids decide the policy.
 */
function isConsistentVercelToken(payload: JWTPayload, teamSlug: string): boolean {
  const owner = claim(payload, 'owner');
  const project = claim(payload, 'project');
  const environment = claim(payload, 'environment');
  if (owner !== teamSlug || project === null || environment === null) return false;
  return claim(payload, 'sub') === `owner:${owner}:project:${project}:environment:${environment}`;
}

/**
 * The policy entry a Vercel token's environment matches. A custom environment matches only by its
 * stable `custom_environment_id`, never by its slug.
 */
function listedVercelEnvironment(
  payload: JWTPayload,
  listed: readonly VercelEnvironment[]
): VercelEnvironment | null {
  if (payload.custom_environment_id !== undefined) {
    const id = claim(payload, 'custom_environment_id');
    return (
      listed.find(entry => typeof entry !== 'string' && entry.customEnvironmentId === id) ?? null
    );
  }
  const environment = claim(payload, 'environment');
  return listed.find(entry => entry === environment) ?? null;
}

/**
 * An exchanged function token's `act` names the base token's audience, the team default
 * `https://vercel.com/<team slug>`, and nothing nested: a token exchanged from an already exchanged
 * token, or one without `act`, did not come from a function's own token.
 */
function isExchangedFromFunctionToken(payload: JWTPayload, issuer: string): boolean {
  const act = payload.act;
  if (typeof act !== 'object' || act === null || Array.isArray(act)) return false;
  if ('act' in act) return false;
  const teamSlug = issuer.slice(VERCEL_ISSUER_PREFIX.length);
  return 'aud' in act && act.aud === `https://vercel.com/${teamSlug}`;
}

/**
 * The bindings of the one policy a GitHub token's environment and workflow file selected: the exact
 * subject, a listed ref, a listed event (an allowlist, so an event no policy lists is refused), and
 * a workflow entry pinned to the run's own ref. A called reusable workflow's `job_workflow_ref`
 * names the ref it was called at, while `ref` is the calling run's: an entry pinned to one listed
 * ref never admits a run on another.
 */
function meetsGithubBindings(payload: JWTPayload, identity: GithubIdentity): boolean {
  const ref = claim(payload, 'ref');
  if (ref === null || !identity.refs.includes(ref)) return false;
  if (!claim(payload, 'job_workflow_ref')?.endsWith(`@${ref}`)) return false;
  const event = claim(payload, 'event_name');
  if (!identity.events.some(listed => listed === event)) return false;
  const subject = claim(payload, 'sub');
  if (subject === githubSubject(identity, ref)) return true;
  // Kilo-Org/kilocode only (the loader refuses the flag elsewhere): its default subject, with the
  // repository and owner id claims already matched above. Why and how to upgrade:
  // GITHUB_LEGACY_SUBJECT_REPOSITORY in ../policy/schema.
  return identity.legacySubject === true && subject === githubLegacySubject(identity, ref);
}

/** Classifies a failed `jwtVerify`: a dependency failure is retryable, anything else is a rejection. */
function isDependencyFailure(error: unknown): boolean {
  return (
    error instanceof ProviderUnavailableError ||
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid
  );
}

/**
 * Verifies provider workload tokens and maps them to a policy. Each policy's own fields decide the
 * issuer and the claim bindings, so an unlisted identity can never match. The audience is the one
 * the verifier is built with: this STS's issuer for every route, and the migration proxy's own
 * audience for `attestGithubRun` alone. Discovery and key sets are cached for the isolate; a fetch
 * that fails is not cached, and it makes the answer `unavailable`, never a rejection (design 7).
 *
 * Only a finished discovery is cached, never its promise: workerd ties a promise to the request
 * that created it, so a request awaiting another request's pending discovery stalls when that
 * request ends first. jose's key set holds plain data and, on Workers, makes each request that
 * needs a reload fetch for itself rather than share a pending fetch.
 */
export class IdentityVerifier {
  private readonly jwks = new Map<string, RemoteJWKSet>();

  constructor(
    private readonly options: {
      policies: Policy[];
      environment: StsEnvironment;
      /** The only `aud` a token may carry. */
      audience: string;
      /** Expose a verified GitHub token's claims as `github` (the migration attestation only). */
      githubClaims?: boolean;
      fetch: typeof fetch;
    }
  ) {}

  private async providerFetch(url: string, init?: RequestInit): Promise<Response> {
    const timeout = AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
    } catch {
      throw new ProviderUnavailableError('provider request failed');
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new ProviderUnavailableError(`provider answered ${response.status}`);
    }
    const text = await response.text();
    try {
      JSON.parse(text);
    } catch {
      throw new ProviderUnavailableError('provider answered with a body that is not JSON');
    }
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  }

  /** A request that finds no key set for the issuer discovers it itself and stores the result. */
  private async jwksFor(issuer: string): Promise<RemoteJWKSet> {
    const existing = this.jwks.get(issuer);
    if (existing) return existing;

    const response = await this.providerFetch(`${issuer}/.well-known/openid-configuration`);
    const document = DiscoverySchema.safeParse(await response.json());
    if (!document.success) throw new ProviderUnavailableError('discovery document is invalid');
    if (document.data.issuer !== issuer) {
      throw new ProviderUnavailableError('discovery issuer does not match');
    }
    const created = createRemoteJWKSet(new URL(document.data.jwks_uri), {
      timeoutDuration: PROVIDER_FETCH_TIMEOUT_MS,
      [customFetch]: (url, init) => this.providerFetch(url, init),
    });
    this.jwks.set(issuer, created);
    return created;
  }

  async verify(token: string): Promise<VerifyOutcome> {
    let unverified: JWTPayload;
    try {
      unverified = decodeJwt(token);
    } catch {
      return { status: 'denied', reason: 'identity_rejected' };
    }
    const issuer = claim(unverified, 'iss');
    if (issuer === null) return { status: 'denied', reason: 'identity_rejected' };

    const candidates = this.options.policies.filter(
      policy => issuerFor(policy.identity) === issuer
    );
    if (candidates.length === 0) {
      return {
        status: 'denied',
        reason: isKnownProviderIssuer(issuer) ? 'unknown_workload' : 'identity_rejected',
      };
    }

    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, await this.jwksFor(issuer), {
        issuer,
        audience: this.options.audience,
        algorithms: ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      payload = result.payload;
    } catch (error) {
      if (isDependencyFailure(error)) return { status: 'unavailable' };
      return { status: 'denied', reason: 'identity_rejected' };
    }

    const provider = providerFor(issuer);
    const { exp, iat } = payload;
    // jose checks `exp` and `nbf` but not a future `iat`; both times must be present.
    if (exp === undefined || iat === undefined) {
      return { status: 'denied', reason: 'identity_rejected' };
    }
    if (iat > Math.floor(Date.now() / 1000) + CLOCK_TOLERANCE_SECONDS) {
      return { status: 'denied', reason: 'identity_rejected' };
    }
    // An exchanged Vercel token carries exactly one audience; anything else (the team-wide default
    // `https://vercel.com/<team>`, or a list naming STS among others) did not come from the exchange.
    if (provider === 'vercel' && payload.aud !== this.options.audience) {
      return { status: 'denied', reason: 'identity_rejected' };
    }
    const verified = (workload: WorkloadName): VerifyOutcome => ({
      status: 'verified',
      workload,
      provider,
      attestationExp: exp,
      attestationIat: iat,
      run: provider === 'github' ? githubRun(payload) : null,
      github:
        provider === 'github' && this.options.githubClaims ? attestedGithubRun(payload) : null,
    });
    const rejected = (workload: string | null, reason: DeniedReason): VerifyOutcome => ({
      status: 'denied',
      reason,
      subject: verifiedSubject(provider, payload, workload),
    });
    if (provider === 'vercel') {
      // A person's `vercel env pull` or `vercel dev` token carries `user_id`; a deployment's
      // function token does not. Refused in every environment, naming the person.
      if (payload.user_id !== undefined) return rejected(null, 'identity_rejected');
      if (!isExchangedFromFunctionToken(payload, issuer)) {
        return rejected(null, 'identity_rejected');
      }
    }
    let mismatchedWorkload: string | null = null;
    // A GitHub token named a policy's repository but no policy for its environment and workflow.
    let unmatchedRepository = false;
    for (const policy of candidates) {
      const identity = policy.identity;
      switch (identity.kind) {
        case 'fly-oidc': {
          if (claim(payload, 'org_id') !== identity.orgId) continue;
          if (claim(payload, 'app_id') !== identity.appId) continue;
          if (claim(payload, 'org_name') !== identity.org) continue;
          if (claim(payload, 'app_name') !== identity.app) continue;
          if (!policy.environments.includes(this.options.environment)) {
            mismatchedWorkload = policy.workload;
            continue;
          }
          return verified(policy.workload);
        }
        case 'github-oidc': {
          if (claim(payload, 'repository_id') !== identity.repositoryId) continue;
          if (claim(payload, 'repository_owner_id') !== identity.repositoryOwnerId) continue;
          // The loader admits one policy per repository, GitHub environment and workflow file, so
          // at most one policy gets past these two checks.
          if (
            claim(payload, 'environment') !== (identity.environment ?? null) ||
            !identity.jobWorkflowRefs.includes(claim(payload, 'job_workflow_ref') ?? '')
          ) {
            unmatchedRepository = true;
            continue;
          }
          // From here the token names this policy's workflow: a failed binding is a rejection,
          // not an unknown workload.
          if (!meetsGithubBindings(payload, identity)) {
            return rejected(policy.workload, 'identity_rejected');
          }
          if (!policy.environments.includes(this.options.environment)) {
            mismatchedWorkload = policy.workload;
            continue;
          }
          return verified(policy.workload);
        }
        case 'vercel-oidc': {
          if (claim(payload, 'owner_id') !== identity.teamId) continue;
          if (claim(payload, 'project_id') !== identity.projectId) continue;
          // From here the token names this policy's project: a failed binding is a rejection.
          if (!isConsistentVercelToken(payload, identity.teamSlug)) {
            return rejected(policy.workload, 'identity_rejected');
          }
          const source = listedVercelEnvironment(payload, identity.environments);
          if (source === null) return rejected(policy.workload, 'identity_rejected');
          if (
            !policy.environments.includes(this.options.environment) ||
            !vercelStsEnvironments(source).includes(this.options.environment)
          ) {
            mismatchedWorkload = policy.workload;
            continue;
          }
          return verified(policy.workload);
        }
        case 'worker-binding':
          continue;
      }
    }

    if (mismatchedWorkload !== null) return rejected(mismatchedWorkload, 'environment_mismatch');
    return rejected(null, unmatchedRepository ? 'identity_rejected' : 'unknown_workload');
  }
}
