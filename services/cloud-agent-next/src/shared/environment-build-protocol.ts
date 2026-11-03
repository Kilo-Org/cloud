import { z } from 'zod';
import { CONTROL_PLANE_GIT_PLATFORMS } from './control-plane-protocol.js';
import { ISOLATED_CONTAINER_WORKSPACE_PATH } from './environment-workspace.js';

/**
 * Environment builder <-> Worker protocol (plan "Build admission and
 * execution"). The builder is a dedicated runner: it has no Session DO, Kilo
 * runtime, model token or transcript. It talks to its environment coordinator
 * through short authenticated HTTP calls bound to one environment, build and
 * allocation, so no request stays open while setup runs.
 *
 * Shared by the wrapper bundle and the Worker, so it imports nothing Worker-only.
 */

/** The directory a V1 builder prepares; the same path every V1 session uses. */
export const ENVIRONMENT_BUILD_WORKSPACE = ISOLATED_CONTAINER_WORKSPACE_PATH;

export const ENVIRONMENT_BUILD_LOG_PATH = '/tmp/kilocode-environment-builder.log';

/**
 * Where the builder's endpoint and credential arrive. The container DO writes
 * the file through an exec after the start, never as start env: a snapshot keeps
 * the container's start configuration, so a restored session would inherit it.
 * The builder deletes the file as soon as it has read it.
 */
export const ENVIRONMENT_BUILD_RUNNER_DIR = '/run/kilocode-environment-build';
export const ENVIRONMENT_BUILD_RUNNER_PATH = `${ENVIRONMENT_BUILD_RUNNER_DIR}/runner.json`;

export const ENVIRONMENT_BUILD_RUNNER_DELIVERY_SCRIPT = [
  'umask 077',
  `mkdir -p ${ENVIRONMENT_BUILD_RUNNER_DIR}`,
  `{ [ ! -e ${ENVIRONMENT_BUILD_RUNNER_PATH}.consumed ] || exit 0; }`,
  `printf '%s' "$KILO_BUILDER_RUNNER" > ${ENVIRONMENT_BUILD_RUNNER_PATH}.tmp`,
  `mv ${ENVIRONMENT_BUILD_RUNNER_PATH}.tmp ${ENVIRONMENT_BUILD_RUNNER_PATH}`,
  `if [ -e ${ENVIRONMENT_BUILD_RUNNER_PATH}.consumed ]; then rm -f ${ENVIRONMENT_BUILD_RUNNER_PATH}; fi`,
].join(' && ');

export const environmentBuildRunnerSchema = z
  .object({ url: z.string().url(), credential: z.string().min(1) })
  .strict();
export type EnvironmentBuildRunner = z.infer<typeof environmentBuildRunnerSchema>;

/** How often a running builder reports liveness. */
export const ENVIRONMENT_BUILD_HEARTBEAT_MS = 15_000;
/** Bound on the text of one log batch, after redaction. */
export const ENVIRONMENT_BUILD_LOG_BATCH_MAX_BYTES = 64 * 1024;
export const ENVIRONMENT_BUILD_LOG_BATCH_MAX_LINES = 512;
/** Bound on one log line the builder forwards. */
export const ENVIRONMENT_BUILD_LOG_LINE_MAX_CHARS = 8_192;

export const environmentBuildGitSchema = z
  .object({
    url: z.string().min(1).max(2048),
    token: z.string().min(1).max(4096).optional(),
    platform: z.enum(CONTROL_PLANE_GIT_PLATFORMS).optional(),
  })
  .strict();
export type EnvironmentBuildGit = z.infer<typeof environmentBuildGitSchema>;

/**
 * One repository of a V2 build: its clone source and the directory it is cloned
 * to. `environmentWorkspace` decides the directory, as it does for a session.
 */
export const environmentBuildMemberSchema = z
  .object({
    url: z.string().min(1).max(2048),
    token: z.string().min(1).max(4096).optional(),
    platform: z.enum(CONTROL_PLANE_GIT_PLATFORMS).optional(),
    directory: z.string().regex(/^\/workspace\/[^/]+$/),
    repoFullName: z.string().min(1).max(500),
  })
  .strict();
export type EnvironmentBuildMember = z.infer<typeof environmentBuildMemberSchema>;

/** One repository the builder reports: the commit it cloned and its branch. */
export const environmentBuildMemberPinSchema = z
  .object({
    repoFullName: z.string().min(1).max(500),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    branch: z.string().min(1).max(256),
  })
  .strict();

/** The commit of each repository of a V2 build, for display only. */
export const environmentBuildPinGroupSchema = z
  .object({ members: z.array(environmentBuildMemberPinSchema).min(1) })
  .strict();
export type EnvironmentBuildPinGroup = z.infer<typeof environmentBuildPinGroupSchema>;

/**
 * What the builder fetches once it starts. Secrets are decrypted only into this
 * reply. A V1 build serves the `git` shape at the isolated directory. A V2 build
 * serves its `members`, and `directory` is the cwd a session of that environment
 * would have: `/workspace/<leaf>` for one repository, `/workspace` for several.
 */
export const environmentBuildInputSchema = z.union([
  z
    .object({
      environmentId: z.string().uuid(),
      buildId: z.string().uuid(),
      allocationId: z.string().uuid(),
      git: environmentBuildGitSchema,
      members: z.undefined().optional(),
      directory: z.literal(ENVIRONMENT_BUILD_WORKSPACE),
      commands: z.array(z.string().min(1).max(16_000)).max(20),
      env: z.record(z.string().min(1).max(128), z.string().max(10_000)),
      /** Names of the secret entries in `env`, so the builder redacts their values. */
      secretKeys: z.array(z.string().min(1).max(128)).max(50),
      deadlineAt: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      environmentId: z.string().uuid(),
      buildId: z.string().uuid(),
      allocationId: z.string().uuid(),
      members: z.array(environmentBuildMemberSchema).min(1),
      git: z.undefined().optional(),
      directory: z.string().regex(/^\/workspace(\/[^/]+)?$/),
      commands: z.array(z.string().min(1).max(16_000)).max(20),
      env: z.record(z.string().min(1).max(128), z.string().max(10_000)),
      secretKeys: z.array(z.string().min(1).max(128)).max(50),
      deadlineAt: z.number().int().positive(),
    })
    .strict(),
]);
export type EnvironmentBuildInput = z.infer<typeof environmentBuildInputSchema>;

/** Steps the builder reports; the coordinator's own states wrap them. */
export const ENVIRONMENT_BUILD_RUNNER_STEPS = ['clone', 'setup', 'cleanup'] as const;
export type EnvironmentBuildRunnerStep = (typeof ENVIRONMENT_BUILD_RUNNER_STEPS)[number];

export const environmentBuildEventsSchema = z
  .object({
    /** Monotonic per builder process; a replayed batch is applied once. */
    sequence: z.number().int().nonnegative(),
    step: z.enum(ENVIRONMENT_BUILD_RUNNER_STEPS).optional(),
    /** Redacted output lines, in order. */
    logs: z
      .array(z.string().max(ENVIRONMENT_BUILD_LOG_LINE_MAX_CHARS))
      .max(ENVIRONMENT_BUILD_LOG_BATCH_MAX_LINES)
      .optional(),
  })
  .strict();
export type EnvironmentBuildEvents = z.infer<typeof environmentBuildEventsSchema>;

/** The coordinator's answer to each events call: keep going, or stop work now. */
export const environmentBuildEventsReplySchema = z
  .object({ action: z.enum(['continue', 'cancel']) })
  .strict();
export type EnvironmentBuildEventsReply = z.infer<typeof environmentBuildEventsReplySchema>;

/** Closed failure reasons a builder can report; each maps to user-visible text. */
export const ENVIRONMENT_BUILD_RUNNER_FAILURES = [
  'input_unavailable',
  'clone_failed',
  'setup_failed',
  'setup_timeout',
  'cleanup_failed',
  'canceled',
] as const;
export type EnvironmentBuildRunnerFailure = (typeof ENVIRONMENT_BUILD_RUNNER_FAILURES)[number];

export const environmentBuildResultSchema = z.union([
  z
    .object({
      outcome: z.literal('ready'),
      /** The exact default-branch commit the workspace was prepared at. */
      commit: z.string().regex(/^[0-9a-f]{40}$/),
      branch: z.string().min(1).max(256),
      members: z.undefined().optional(),
      setupDurationMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('ready'),
      /** One entry per repository, reported after every clone and before cleanup. */
      members: environmentBuildPinGroupSchema,
      commit: z.undefined().optional(),
      branch: z.undefined().optional(),
      setupDurationMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('failed'),
      step: z.enum(ENVIRONMENT_BUILD_RUNNER_STEPS),
      reason: z.enum(ENVIRONMENT_BUILD_RUNNER_FAILURES),
      /** A command index or a short safe phrase; never output, values or URLs. */
      detail: z.string().max(200).optional(),
    })
    .strict(),
]);
export type EnvironmentBuildResult = z.infer<typeof environmentBuildResultSchema>;
