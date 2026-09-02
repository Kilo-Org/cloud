import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const ARTIFACT_VERSION = 1;
export const Id = z.string().min(1).max(256);
export const Sha = z.string().regex(/^[a-f0-9]{40}$/);
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const Model = z.string().trim().min(1).max(512);
export const Effort = z
  .string()
  .regex(/^[a-zA-Z]+$/)
  .max(50)
  .nullable();
export const JsonRecord = z.record(z.string(), z.unknown());
export const Timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)));
export const Match = z.enum(['matched', 'mismatched', 'pending']);
export type Match = z.infer<typeof Match>;

export const Preparation = z.looseObject({
  version: z.literal(1),
  executionUserId: Id,
  requestingUserId: Id,
  organizationId: Id.optional(),
  settings: z.looseObject({
    model: Model,
    thinkingEffort: Effort,
    modelSource: z.enum(['explicit', 'repository', 'global']),
    analyticsEnabled: z.boolean(),
  }),
  snapshot: z.object({ headSha: Sha, baseTipSha: Sha, mergeBaseSha: Sha }),
  hashes: z.object({
    settings: Hash,
    context: Hash,
    canonicalPrompt: Hash,
    adaptedPrompt: Hash,
    system: Hash,
  }),
});
export type Preparation = z.infer<typeof Preparation>;

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function redactArtifact(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets.filter(Boolean)) text = text.replaceAll(secret, '[REDACTED]');
    return text
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
      .replace(
        /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g,
        '[REDACTED]'
      )
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  }
  if (Array.isArray(value)) return value.map(item => redactArtifact(item, secrets));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:headers|authorization|cookie|set-cookie|credentials|.*password|.*secret|.*(?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token)|kiloToken|gitToken|githubToken|token)$/i.test(
          key
        )
          ? '[REDACTED]'
          : redactArtifact(item, secrets),
      ])
    );
  }
  return value;
}

export function createPrivateArtifacts(directory: string, secrets: string[] = []) {
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  return (name: string, data: unknown): void => {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Error('Invalid artifact name');
    const path = join(directory, name);
    const text = `${JSON.stringify({ version: ARTIFACT_VERSION, data: redactArtifact(data, secrets) }, null, 2)}\n`;
    writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
  };
}

export function readPrivateText(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 32 * 1024 * 1024) {
    throw new Error('Input artifacts must be private regular files (0600), at most 32 MiB');
  }
  return readFileSync(path, 'utf8');
}

export function readPrivateJson(path: string): unknown {
  const text = readPrivateText(path);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON artifact');
  }
}

export function unwrapArtifact(value: unknown): unknown {
  return z.object({ version: z.literal(ARTIFACT_VERSION), data: z.unknown() }).parse(value).data;
}

export async function jsonRequest(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch
): Promise<{ status: number; body: unknown }> {
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return { status: response.status, body: null };
    const body: unknown = await response.json();
    return { status: response.status, body };
  } catch {
    throw new Error('HTTP response unavailable; do not retry a creation POST');
  }
}

export function fixturePrompt(
  value: unknown,
  expected?: { owner: string; repo: string; pullNumber: number; headSha: string }
): { userPrompt: string; source: string; model?: string; thinkingEffort?: string | null } {
  const prompt = z
    .string()
    .max(64_000)
    .refine(text => text.trim().length > 0);
  if (typeof value === 'string') return { userPrompt: prompt.parse(value), source: 'fixture-text' };
  const artifact = z
    .object({
      owner: Id,
      repo: Id,
      pullNumber: z.number().int().positive(),
      headSha: Sha,
      userPrompt: prompt,
      model: Model,
      thinkingEffort: Effort.optional(),
      preparation: Preparation,
      gitToken: z.never().optional(),
      kiloToken: z.never().optional(),
      credentials: z.never().optional(),
    })
    .parse(value);
  if (artifact.preparation.hashes.adaptedPrompt !== hashText(artifact.userPrompt))
    throw new Error('Prepared fixture prompt does not match its adapted prompt hash');
  if (
    artifact.model !== artifact.preparation.settings.model ||
    (artifact.thinkingEffort ?? null) !== artifact.preparation.settings.thinkingEffort ||
    artifact.headSha !== artifact.preparation.snapshot.headSha
  )
    throw new Error('Prepared fixture request settings/snapshot mismatch');
  if (
    !expected ||
    artifact.owner.toLowerCase() !== expected.owner.toLowerCase() ||
    artifact.repo.toLowerCase() !== expected.repo.toLowerCase() ||
    artifact.pullNumber !== expected.pullNumber ||
    artifact.headSha !== expected.headSha
  )
    throw new Error(
      'Prepared prompt artifact does not match the fixture repository, PR or head SHA'
    );
  return {
    userPrompt: artifact.userPrompt,
    source: 'canonical-prepared-request',
    model: artifact.model,
    thinkingEffort: artifact.thinkingEffort ?? null,
  };
}

export const Finding = z
  .object({
    path: z.string().min(1),
    currentLine: z.number().int().positive().nullable(),
    side: z.enum(['LEFT', 'RIGHT']).nullable(),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'unknown']),
    description: z.string().trim().min(1),
    validity: z.enum(['valid', 'invalid', 'unreviewed']),
    novelty: z.enum(['new', 'duplicate', 'unknown']),
    location: z.enum(['inline', 'summary-only']),
    proposed: z.boolean(),
    published: z.boolean().nullable(),
    lineTarget: z.enum(['correct', 'incorrect', 'unreviewed']),
    expectedDefectId: Id.optional(),
  })
  .strict();
export type Finding = z.infer<typeof Finding>;

export function normalizeFinding(input: Finding) {
  const finding = Finding.parse(input);
  const path = finding.path
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\/workspace\//, '')
    .replace(/^(?:\.\/)+/, '');
  if (path.startsWith('/') || path.split('/').some(part => !part || part === '..')) {
    throw new Error('Findings require repository-relative paths without traversal');
  }
  if (finding.location === 'inline' && (finding.currentLine === null || finding.side === null)) {
    throw new Error(
      'Inline findings require a current line and side; never substitute original_line'
    );
  }
  const description = finding.description.replace(/\s+/g, ' ');
  return {
    ...finding,
    path,
    description,
    key: hashText(
      JSON.stringify([path, finding.currentLine, finding.side, finding.severity, description])
    ),
  };
}

export const Ledger = z
  .object({
    version: z.literal(1),
    pairId: Id,
    source: z.literal('external-human-ledger'),
    expectedDefects: z.array(z.object({ id: Id, severity: Finding.shape.severity }).strict()),
    findings: z.object({ candidate: z.array(Finding), control: z.array(Finding) }).strict(),
    summaryAccuracy: z
      .object({
        candidate: z.enum(['accurate', 'inaccurate', 'unreviewed']),
        control: z.enum(['accurate', 'inaccurate', 'unreviewed']),
      })
      .strict(),
  })
  .strict();
export type Ledger = z.infer<typeof Ledger>;

const Microdollars = z
  .union([z.number().int().nonnegative().safe(), z.string().regex(/^\d+$/)])
  .transform(String);
export const Cost = z.object({
  billedMicrodollars: Microdollars.nullable(),
  marketMicrodollars: Microdollars.nullable(),
  inferenceBilledMicrodollars: Microdollars.nullable(),
  classifierBilledMicrodollars: Microdollars.nullable(),
  accounting: z.literal('unproven'),
  reason: z.string(),
});
export type Cost = z.infer<typeof Cost>;
export function unmeasuredCost(): Cost {
  return {
    billedMicrodollars: null,
    marketMicrodollars: null,
    inferenceBilledMicrodollars: null,
    classifierBilledMicrodollars: null,
    accounting: 'unproven',
    reason: 'No attributed usage artifact; model, gateway and infrastructure cost are unmeasured.',
  };
}

export const Arm = z.object({
  arm: z.enum(['candidate', 'control']),
  id: Id.nullable(),
  attempted: z.boolean(),
  accepted: z.boolean().nullable(),
  completed: z.boolean(),
  status: z.string(),
  publicationRequested: z.boolean(),
  publication: z.enum(['dry-run', 'confirmed', 'partial', 'uncertain', 'not-published', 'unknown']),
  inputMatch: Match,
  rootSessionIds: z.array(Id),
  childSessionIds: z.array(Id),
  requestIds: z.array(Id),
  cost: Cost,
});
export type Arm = z.infer<typeof Arm>;

export function usageCost(value: unknown, arm: Arm, executionUserId: string): Cost {
  const usage = z
    .looseObject({
      userId: Id,
      scope: z.enum(['session', 'session-set']),
      sessionIdsJson: z.string(),
      aggregateCompleteness: z.literal('all-matched-rows-at-query-time'),
      runAccountingCompleteness: z.literal('unproven'),
      billedMicrodollars: Microdollars,
      marketMicrodollars: Microdollars.nullable(),
      inferenceBilledMicrodollars: Microdollars,
      classifierBilledMicrodollars: Microdollars,
    })
    .parse(value);
  const ids = z.array(Id).nonempty().parse(JSON.parse(usage.sessionIdsJson));
  const known = new Set([...arm.rootSessionIds, ...arm.childSessionIds]);
  if (usage.userId !== executionUserId || ids.some(id => !known.has(id))) {
    throw new Error(
      'Usage must belong to the execution user and known root/child sessions, not the review UUID or user window'
    );
  }
  return {
    billedMicrodollars: usage.billedMicrodollars,
    marketMicrodollars: usage.marketMicrodollars,
    inferenceBilledMicrodollars: usage.inferenceBilledMicrodollars,
    classifierBilledMicrodollars: usage.classifierBilledMicrodollars,
    accounting: 'unproven',
    reason:
      'Known lower bound only: full SQL totals do not prove run attribution, child mapping, expected requests or settled metadata. Gateway/infra cost unmeasured.',
  };
}

export const ControlDiagnostic = z
  .object({
    version: z.literal(1),
    source: z.literal('private-captured-dispatch-diagnostic'),
    reviewId: z.uuid(),
    attemptId: z.uuid(),
    phase: z.literal('post-analytics-appendix'),
    model: Model,
    variant: Effort,
    analytics_enabled_at_dispatch: z.boolean().nullable(),
    promptSha256: Hash,
    promptLength: z.number().int().nonnegative(),
    packagedCliVersion: z.literal('7.4.20'),
    outputMode: z.enum(['provider', 'kilo']).optional(),
    headSha: Sha.optional(),
    baseTipSha: Sha.optional(),
    mergeBaseSha: Sha.optional(),
    settingsHash: Hash.optional(),
    contextHash: Hash.optional(),
    skillVersion: Id.optional(),
    childSessions: z.array(z.object({ sessionId: Id, parentSessionId: Id }).strict()).default([]),
    requestIds: z.array(Id).default([]),
  })
  .strict();
export type ControlDiagnostic = z.infer<typeof ControlDiagnostic>;

export function compareValue(expected: unknown, actual: unknown): Match {
  if (expected === undefined || actual === undefined) return 'pending';
  return JSON.stringify(expected) === JSON.stringify(actual) ? 'matched' : 'mismatched';
}

export function combineMatches(checks: Match[]): Match {
  if (checks.includes('mismatched')) return 'mismatched';
  return checks.length > 0 && checks.every(check => check === 'matched') ? 'matched' : 'pending';
}

export function verifyControl(
  preparation: Preparation,
  value: unknown,
  diagnostic?: ControlDiagnostic
) {
  const payload = z.object({ review: JsonRecord, attempts: z.array(JsonRecord) }).parse(value);
  const review = payload.review;
  const manual = JsonRecord.safeParse(review.manual_config);
  const config = JsonRecord.safeParse(manual.success ? manual.data.agentConfig : undefined);
  const attempts = z
    .array(
      z.looseObject({
        id: z.uuid(),
        attempt_number: z.number().int().positive(),
        analytics_enabled_at_dispatch: z.boolean().nullable().optional(),
      })
    )
    .parse(payload.attempts);
  const attempt = attempts.sort((left, right) => right.attempt_number - left.attempt_number)[0];
  const settings = config.success ? config.data : {};
  const checks: Record<string, Match> = {
    outputMode: compareValue('provider', manual.success ? manual.data.outputMode : undefined),
    model: compareValue(preparation.settings.model, settings.model_slug),
    effort: compareValue(preparation.settings.thinkingEffort, settings.thinking_effort),
    observedModel: compareValue(
      preparation.settings.model,
      preparation.settings.model.startsWith('kilo-auto/')
        ? diagnostic?.model
        : (review.model ?? undefined)
    ),
    headSha: compareValue(preparation.snapshot.headSha, review.head_sha),
    analyticsAtDispatch: compareValue(
      preparation.settings.analyticsEnabled,
      attempt?.analytics_enabled_at_dispatch ?? undefined
    ),
    dispatchDiagnostic: diagnostic ? 'matched' : 'pending',
    settingsHash: compareValue(preparation.hashes.settings, diagnostic?.settingsHash),
    contextHash: compareValue(preparation.hashes.context, diagnostic?.contextHash),
    authoritativeSkillCaptured: diagnostic?.skillVersion ? 'matched' : 'pending',
    baseTipSha: compareValue(preparation.snapshot.baseTipSha, diagnostic?.baseTipSha),
    mergeBaseSha: compareValue(preparation.snapshot.mergeBaseSha, diagnostic?.mergeBaseSha),
  };
  if (diagnostic) {
    checks.diagnosticReview = compareValue(review.id, diagnostic.reviewId);
    checks.diagnosticAttempt = compareValue(attempt?.id, diagnostic.attemptId);
    checks.dispatchedModel = compareValue(preparation.settings.model, diagnostic.model);
    checks.dispatchedEffort = compareValue(preparation.settings.thinkingEffort, diagnostic.variant);
    checks.dispatchedHead = compareValue(preparation.snapshot.headSha, diagnostic.headSha);
    checks.dispatchedAnalytics = compareValue(
      preparation.settings.analyticsEnabled,
      diagnostic.analytics_enabled_at_dispatch ?? undefined
    );
    checks.dispatchedOutputMode = compareValue('provider', diagnostic.outputMode);
  }
  return {
    checks,
    match: combineMatches(Object.values(checks)),
    promptHash: diagnostic?.promptSha256 ?? null,
    promptHashComparison: 'Not byte-compared: control fix links and runtime adapters differ.',
  };
}

export function addKnownControlChildren(arm: Arm, diagnostic: ControlDiagnostic): Arm {
  if (diagnostic.reviewId !== arm.id)
    throw new Error('Control diagnostic belongs to another review');
  const known = new Set(arm.rootSessionIds);
  const remaining = [...diagnostic.childSessions];
  for (let count = remaining.length; count > 0; count--) {
    for (let index = remaining.length - 1; index >= 0; index--) {
      const child = remaining[index];
      if (known.has(child.parentSessionId) && child.sessionId !== arm.id) {
        known.add(child.sessionId);
        remaining.splice(index, 1);
      }
    }
  }
  if (remaining.length) throw new Error('Control child mapping has an unknown parent');
  return {
    ...arm,
    childSessionIds: [...known].filter(id => !arm.rootSessionIds.includes(id)).sort(),
    requestIds: [...new Set([...arm.requestIds, ...diagnostic.requestIds])].sort(),
  };
}

function sumCost(arms: Arm[], field: 'billedMicrodollars' | 'marketMicrodollars') {
  const values = arms.flatMap(arm => (arm.cost[field] === null ? [] : [arm.cost[field]]));
  return values.length ? values.reduce((sum, value) => sum + BigInt(value), 0n).toString() : null;
}

function costRate(knownMicrodollars: string | null, denominator: number) {
  return denominator === 0 || knownMicrodollars === null
    ? null
    : {
        numeratorMicrodollars: knownMicrodollars,
        denominator,
        accounting: 'known-lower-bound' as const,
      };
}

export function aggregateArms(arms: Arm[], findings: Finding[] = []) {
  const attempted = arms.filter(arm => arm.attempted).length;
  const accepted = arms.filter(arm => arm.accepted === true).length;
  const completed = arms.filter(arm => arm.accepted === true && arm.completed).length;
  const valid = findings.filter(
    finding => finding.validity === 'valid' && finding.novelty === 'new'
  );
  const validProposed = valid.filter(finding => finding.proposed).length;
  const validPublished = valid.filter(finding => finding.published === true).length;
  const billed = sumCost(arms, 'billedMicrodollars');
  const acceptedPublishing = arms.filter(arm => arm.accepted === true && arm.publicationRequested);
  const confirmedPublications = acceptedPublishing.filter(
    arm => arm.publication === 'confirmed'
  ).length;
  return {
    attempted,
    accepted,
    acceptanceUnknown: arms.filter(arm => arm.attempted && arm.accepted === null).length,
    completed,
    completionReliability: accepted === 0 ? null : completed / accepted,
    publicationReliability: {
      acceptedPublishingRuns: acceptedPublishing.length,
      confirmed: confirmedPublications,
      unknown: acceptedPublishing.filter(
        arm => arm.publication === 'unknown' || arm.publication === 'uncertain'
      ).length,
      confirmedFractionLowerBound: acceptedPublishing.length
        ? confirmedPublications / acceptedPublishing.length
        : null,
    },
    publicationOutcomes: arms.map(arm => ({ arm: arm.arm, id: arm.id, outcome: arm.publication })),
    inputMismatches: arms.filter(arm => arm.inputMatch === 'mismatched').length,
    inputPending: arms.filter(arm => arm.inputMatch === 'pending').length,
    validNewProposed: validProposed,
    validNewPublished: validPublished,
    cost: {
      knownBilledMicrodollars: billed,
      knownMarketMicrodollars: sumCost(arms, 'marketMicrodollars'),
      accounting: billed === null ? 'unmeasured' : 'known-lower-bound',
      includesFailedAndMismatchedArms: true,
      perAttemptedRun: costRate(billed, attempted),
      perCompletedReview: costRate(billed, completed),
      perValidNewProposedFinding: costRate(billed, validProposed),
      perValidNewPublishedFinding: costRate(billed, validPublished),
      gatewayCost: 'unmeasured',
      infrastructureCost: 'unmeasured',
      favorableCompleteCostComparisonSupported: false,
    },
  };
}

export function findingQuality(findings: Finding[], expected: Ledger['expectedDefects']) {
  const normalized = findings
    .map(normalizeFinding)
    .sort((left, right) => left.key.localeCompare(right.key));
  const expectedIds = new Set(expected.map(defect => defect.id));
  if (
    expectedIds.size !== expected.length ||
    normalized.some(f => f.expectedDefectId && !expectedIds.has(f.expectedDefectId))
  ) {
    throw new Error(
      'Expected defect IDs must be unique and all finding labels must reference the ledger'
    );
  }
  const adjudicated = normalized.filter(
    finding => finding.proposed && finding.validity !== 'unreviewed'
  );
  const valid = adjudicated.filter(
    finding => finding.validity === 'valid' && finding.novelty === 'new'
  );
  const detected = new Set(
    valid.flatMap(finding => (finding.expectedDefectId ? [finding.expectedDefectId] : []))
  );
  const pendingLabels = normalized.filter(
    finding => finding.validity === 'unreviewed' || finding.novelty === 'unknown'
  ).length;
  const highSeverityNotConfirmed = expected
    .filter(defect => ['critical', 'high'].includes(defect.severity) && !detected.has(defect.id))
    .map(defect => defect.id);
  return {
    findings: normalized,
    adjudication: pendingLabels ? 'partial' : 'complete-for-supplied-ledger',
    precisionValidNewProposed:
      adjudicated.length && pendingLabels === 0 ? valid.length / adjudicated.length : null,
    recallLabeledDefectsProposed:
      expected.length && pendingLabels === 0 ? detected.size / expected.length : null,
    highSeverityMisses: pendingLabels ? null : highSeverityNotConfirmed,
    highSeverityNotConfirmed,
    falsePositives: adjudicated.filter(finding => finding.validity === 'invalid').length,
    duplicates: normalized.filter(finding => finding.novelty === 'duplicate').length,
    incorrectLineTargets: normalized.filter(finding => finding.lineTarget === 'incorrect').length,
    unreviewed: normalized.filter(finding => finding.validity === 'unreviewed').length,
  };
}
