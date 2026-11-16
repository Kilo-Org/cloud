/**
 * The draft a trigger form edits, and the two wire payloads it produces.
 *
 * Every field, and every payload, is derived from the procedures themselves, so
 * the form cannot drift from the contract it posts. The rules restated here are
 * the ones the form can check before it sends: the agent slug pattern from
 * `apps/web/src/lib/webhook-trigger-validation.ts`, and the required fields the
 * router's `superRefine` names. Everything else (cron validity, timezone,
 * secret strength for a creator run) is the server's, and its message is shown
 * on the form.
 *
 * No React and no React Native imports: unit-tested directly.
 */

import {
  type inferRouterInputs,
  type inferRouterOutputs,
  type MobileRouter,
} from '@kilocode/trpc/mobile';
import { z } from 'zod';

import { type TriggerNameProblem, triggerNameProblem } from './trigger-id';

export type CloudTriggerCreateInput = inferRouterInputs<MobileRouter>['webhookTriggers']['create'];
export type CloudTriggerUpdateInput = inferRouterInputs<MobileRouter>['webhookTriggers']['update'];
export type CloudTriggerDetail = inferRouterOutputs<MobileRouter>['webhookTriggers']['get'];
export type CloudTriggerListRow =
  inferRouterOutputs<MobileRouter>['webhookTriggers']['list'][number];
export type CloudTriggerDelivery =
  inferRouterOutputs<MobileRouter>['webhookTriggers']['listRequests'][number];

/** The body schema a create or update carries: a JSON Schema object. */
type CloudTriggerBodySchema = Record<string, unknown>;

/** The web form's default prompts, so both surfaces start a trigger the same way. */
const WEBHOOK_PROMPT_TEMPLATE = 'Describe this webhook request payload:\n\n{{body}}';
const SCHEDULED_PROMPT_TEMPLATE = 'Run the scheduled task. Triggered at {{scheduledTime}}.';

/** The secret length a creator-run webhook must carry (the server's minimum). */
const MIN_CREATOR_SECRET_LENGTH = 16;

const AGENT_SLUG = /^(?!custom$)[a-z][a-z0-9-]*$/;

export type TriggerActivation = 'webhook' | 'scheduled';

export type TriggerDraft = Readonly<{
  name: string;
  activation: TriggerActivation;
  cron: string;
  timezone: string;
  repository: string;
  agent: string;
  model: string;
  variant: string;
  prompt: string;
  environmentId: string | null;
  profileId: string | null;
  /** The body schema as the person typed it; an empty string is no schema. */
  bodySchemaJson: string;
  autoCommit: boolean;
  condenseOnComplete: boolean;
  active: boolean;
  authEnabled: boolean;
  authHeader: string;
  authSecret: string;
  runAsCreator: boolean;
}>;

/** The fields a problem can be attached to, so the form can place its copy. */
type TriggerDraftField =
  | 'name'
  | 'cron'
  | 'repository'
  | 'agent'
  | 'model'
  | 'prompt'
  | 'bodySchema'
  | 'authHeader'
  | 'authSecret';

export type TriggerProblem =
  | TriggerNameProblem
  | 'cronRequired'
  | 'repositoryRequired'
  | 'agentRequired'
  | 'agentInvalid'
  | 'modelRequired'
  | 'promptRequired'
  | 'bodySchemaInvalid'
  | 'authHeaderRequired'
  | 'authSecretRequired'
  | 'authSecretTooShort';

export type TriggerDraftProblems = Partial<Record<TriggerDraftField, TriggerProblem>>;

/** The prompt a new draft starts on, for the activation it fires from. */
export function defaultPrompt(activation: TriggerActivation): string {
  return activation === 'scheduled' ? SCHEDULED_PROMPT_TEMPLATE : WEBHOOK_PROMPT_TEMPLATE;
}

/**
 * A new trigger's draft. The time zone starts at the device's own, matching the
 * web form, and the agent starts on `code`, the mode a Cloud Agent run defaults
 * to when a profile names none.
 */
export function createTriggerDraft(timezone: string): TriggerDraft {
  return {
    name: '',
    activation: 'webhook',
    cron: '',
    timezone,
    repository: '',
    agent: 'code',
    model: '',
    variant: '',
    prompt: defaultPrompt('webhook'),
    environmentId: null,
    profileId: null,
    bodySchemaJson: '',
    autoCommit: false,
    condenseOnComplete: false,
    active: true,
    authEnabled: false,
    authHeader: '',
    authSecret: '',
    runAsCreator: false,
  };
}

/** The draft an existing trigger's configuration fills, for the edit form. */
export function triggerDraftFromDetail(detail: CloudTriggerDetail): TriggerDraft {
  return {
    name: detail.triggerId,
    activation: detail.activationMode === 'scheduled' ? 'scheduled' : 'webhook',
    cron: detail.cronExpression ?? '',
    timezone: detail.cronTimezone ?? '',
    repository: detail.githubRepo ?? '',
    agent: detail.mode ?? 'code',
    model: detail.model ?? '',
    variant: detail.variant ?? '',
    prompt: detail.promptTemplate,
    environmentId: detail.environmentId ?? null,
    profileId: detail.profileId ?? null,
    bodySchemaJson: detail.bodySchema ? JSON.stringify(detail.bodySchema, null, 2) : '',
    autoCommit: detail.autoCommit ?? false,
    condenseOnComplete: detail.condenseOnComplete ?? false,
    active: detail.isActive,
    authEnabled: detail.webhookAuthConfigured,
    authHeader: detail.webhookAuthHeader ?? '',
    authSecret: '',
    runAsCreator: detail.executionUserId != null,
  };
}

const jsonObjectSchema = z.record(z.string(), z.unknown());

/**
 * The body schema as a JSON object, `null` for an empty field, or `undefined`
 * when the text is not a JSON object at all.
 *
 * Only the shape is checked here: whether the schema is inside the keyword
 * subset the worker accepts is the server's answer, and it names the offending
 * keyword.
 */
export function readBodySchema(text: string): CloudTriggerBodySchema | null | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const object = jsonObjectSchema.safeParse(JSON.parse(trimmed));
    return object.success ? object.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The problems the form can see before it sends. A scheduled trigger carries no
 * webhook authentication, so its header and secret are not checked, and a
 * webhook's body schema is checked only where the field is shown.
 */
export function triggerDraftProblems(
  draft: TriggerDraft,
  context: Readonly<{ mode: 'create' | 'edit'; authConfigured: boolean }>
) {
  const problems: TriggerDraftProblems = {};
  const nameProblem = triggerNameProblem(draft.name, context.mode);
  if (nameProblem !== null) {
    problems.name = nameProblem;
  }
  const isScheduled = draft.activation === 'scheduled';
  if (isScheduled && draft.cron.trim().length === 0) {
    problems.cron = 'cronRequired';
  }
  if (draft.repository.trim().length === 0) {
    problems.repository = 'repositoryRequired';
  }
  if (draft.agent.length === 0) {
    problems.agent = 'agentRequired';
  } else if (draft.agent.length > 50 || !AGENT_SLUG.test(draft.agent)) {
    problems.agent = 'agentInvalid';
  }
  if (draft.model.trim().length === 0) {
    problems.model = 'modelRequired';
  }
  if (draft.prompt.trim().length === 0) {
    problems.prompt = 'promptRequired';
  }
  if (!isScheduled && readBodySchema(draft.bodySchemaJson) === undefined) {
    problems.bodySchema = 'bodySchemaInvalid';
  }
  if (!isScheduled && draft.authEnabled) {
    if (draft.authHeader.trim().length === 0) {
      problems.authHeader = 'authHeaderRequired';
    }
    const secret = draft.authSecret.trim();
    if (!context.authConfigured && secret.length === 0) {
      problems.authSecret = 'authSecretRequired';
    } else if (
      draft.runAsCreator &&
      secret.length > 0 &&
      secret.length < MIN_CREATOR_SECRET_LENGTH
    ) {
      problems.authSecret = 'authSecretTooShort';
    }
  }
  return problems;
}

export function hasTriggerDraftProblems(problems: TriggerDraftProblems): boolean {
  return Object.keys(problems).length > 0;
}

/**
 * The create payload, or `null` when the body schema text is not a JSON object
 * (the form already shows that problem on the field).
 *
 * Only a Cloud Agent trigger is ever created here: the app does not offer a
 * KiloClaw Chat target, so `targetType` stays at its server default.
 */
export function buildCreateInput(
  draft: TriggerDraft,
  organizationId: string | undefined
): CloudTriggerCreateInput | null {
  const isScheduled = draft.activation === 'scheduled';
  const bodySchema = readBodySchema(draft.bodySchemaJson);
  if (!isScheduled && bodySchema === undefined) {
    return null;
  }
  const authHeader = draft.authHeader.trim();
  const authSecret = draft.authSecret.trim();
  return {
    triggerId: draft.name,
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(organizationId !== undefined && draft.runAsCreator ? { runAsCreator: true } : {}),
    activationMode: draft.activation,
    ...(isScheduled ? { cronExpression: draft.cron.trim(), cronTimezone: draft.timezone } : {}),
    githubRepo: draft.repository,
    mode: draft.agent,
    model: draft.model,
    ...(draft.variant.length > 0 ? { variant: draft.variant } : {}),
    promptTemplate: draft.prompt.trim(),
    environmentId: draft.environmentId,
    profileId: draft.profileId,
    ...(!isScheduled && bodySchema !== null ? { bodySchema } : {}),
    autoCommit: draft.autoCommit,
    condenseOnComplete: draft.condenseOnComplete,
    ...(!isScheduled && draft.authEnabled
      ? { webhookAuth: { header: authHeader, secret: authSecret } }
      : {}),
  };
}

/**
 * The update payload. A name, its repository and its activation never change
 * after creation, so they are not sent; an empty variant and a cleared
 * environment or profile are sent as `null`, which is how the server clears a
 * stored value.
 */
export function buildUpdateInput(
  draft: TriggerDraft,
  context: Readonly<{ triggerId: string; organizationId?: string; authConfigured: boolean }>
): CloudTriggerUpdateInput | null {
  const isScheduled = draft.activation === 'scheduled';
  const bodySchema = readBodySchema(draft.bodySchemaJson);
  if (!isScheduled && bodySchema === undefined) {
    return null;
  }
  const authHeader = draft.authHeader.trim();
  const authSecret = draft.authSecret.trim();
  let webhookAuth: Pick<CloudTriggerUpdateInput, 'webhookAuth'> | undefined = undefined;
  if (!isScheduled) {
    webhookAuth = draft.authEnabled
      ? {
          webhookAuth: {
            header: authHeader,
            ...(authSecret.length > 0 || !context.authConfigured ? { secret: authSecret } : {}),
          },
        }
      : { webhookAuth: { header: null, secret: null } };
  }
  return {
    triggerId: context.triggerId,
    ...(context.organizationId === undefined ? {} : { organizationId: context.organizationId }),
    mode: draft.agent,
    model: draft.model,
    variant: draft.variant.length > 0 ? draft.variant : null,
    promptTemplate: draft.prompt.trim(),
    environmentId: draft.environmentId,
    profileId: draft.profileId,
    ...(!isScheduled ? { bodySchema } : {}),
    autoCommit: draft.autoCommit,
    condenseOnComplete: draft.condenseOnComplete,
    isActive: draft.active,
    ...(isScheduled ? { cronExpression: draft.cron.trim(), cronTimezone: draft.timezone } : {}),
    ...webhookAuth,
  };
}
