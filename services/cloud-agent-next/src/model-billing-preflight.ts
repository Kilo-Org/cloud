import {
  checkCloudAgentAdmission,
  type CloudAgentModelBilling,
  type CloudAgentModelBillingOwner,
} from './cloud-agent-admission.js';
import { TRPCError } from '@trpc/server';
import { getPgDb } from './db/pg.js';
import { assertOrganizationMembership, requireCurrentSessionAccess } from './session-access.js';
import { requireSessionMetadata } from './session/model-preflight.js';
import type { Env, ValidatedSessionAccess } from './types.js';

type ModelBillingProcedure =
  | 'prepareSession'
  | 'start'
  | 'initiateFromKilocodeSessionV2'
  | 'sendMessageV2'
  | 'send'
  | 'kilo.prompt_async';

type ModelBillingPreflightInput = {
  env: Env;
  userId: string;
  authToken: string;
  procedure: string;
  body: unknown;
  validatedSessionAccess?: ValidatedSessionAccess;
};

export type ModelBillingPreflightResult = {
  classification: CloudAgentModelBilling;
  /** Owner balance; only populated when `classification === 'balance-required'`. */
  balance: number | null;
  isDepleted: boolean | null;
  owner: CloudAgentModelBillingOwner;
  validatedSessionAccess?: ValidatedSessionAccess;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isModelBillingProcedure(procedure: string): procedure is ModelBillingProcedure {
  return (
    procedure === 'prepareSession' ||
    procedure === 'start' ||
    procedure === 'initiateFromKilocodeSessionV2' ||
    procedure === 'sendMessageV2' ||
    procedure === 'send' ||
    procedure === 'kilo.prompt_async'
  );
}

function stringProperty(value: Record<string, unknown>, property: string): string | undefined {
  const candidate = value[property];
  return typeof candidate === 'string' ? candidate : undefined;
}

function nestedRecord(
  value: Record<string, unknown>,
  property: string
): Record<string, unknown> | undefined {
  const candidate = value[property];
  return isRecord(candidate) ? candidate : undefined;
}

function requiredModel(model: string | undefined): string {
  if (!model) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Model is required for billing admission',
    });
  }
  return model;
}

function requestedOrganizationId(
  procedure: ModelBillingProcedure,
  body: Record<string, unknown>
): string | undefined {
  if (procedure === 'start') {
    return stringProperty(nestedRecord(body, 'options') ?? {}, 'kilocodeOrganizationId');
  }
  return stringProperty(body, 'kilocodeOrganizationId');
}

function submittedModel(
  procedure: 'prepareSession' | 'start',
  body: Record<string, unknown>
): string {
  if (procedure === 'prepareSession') return requiredModel(stringProperty(body, 'model'));
  return requiredModel(stringProperty(nestedRecord(body, 'agent') ?? {}, 'model'));
}

function sessionId(body: Record<string, unknown>): string {
  const value = stringProperty(body, 'cloudAgentSessionId');
  if (!value) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cloud Agent session ID is required' });
  }
  return value;
}

function requestedExistingSessionModel(
  procedure: Exclude<
    ModelBillingProcedure,
    'prepareSession' | 'start' | 'initiateFromKilocodeSessionV2'
  >,
  body: Record<string, unknown>
): string | undefined {
  switch (procedure) {
    case 'sendMessageV2': {
      const payload = nestedRecord(body, 'payload');
      if (payload?.['type'] === 'prompt') {
        return stringProperty(payload, 'model');
      }
      return payload ? undefined : stringProperty(body, 'model');
    }
    case 'send':
    case 'kilo.prompt_async':
      return stringProperty(nestedRecord(body, 'agent') ?? {}, 'model');
  }
}

export async function preflightCloudAgentModelBilling(
  input: ModelBillingPreflightInput
): Promise<ModelBillingPreflightResult> {
  if (!isModelBillingProcedure(input.procedure)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unsupported billing procedure' });
  }
  const procedure = input.procedure;
  if (!isRecord(input.body)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid request body' });
  }

  if (procedure === 'prepareSession' || procedure === 'start') {
    const organizationId = requestedOrganizationId(procedure, input.body);
    if (organizationId) {
      await assertOrganizationMembership(getPgDb(input.env), input.userId, organizationId);
    }
    const owner: CloudAgentModelBillingOwner = organizationId
      ? { organizationId }
      : { userId: input.userId };
    const admission = await checkCloudAgentAdmission({
      env: input.env,
      token: input.authToken,
      modelId: submittedModel(procedure, input.body),
      owner,
    });
    return { ...admission, owner };
  }

  const cloudAgentSessionId = sessionId(input.body);
  const access = await requireCurrentSessionAccess({
    env: input.env,
    kiloUserId: input.userId,
    cloudAgentSessionId,
    expectedOrganizationId: requestedOrganizationId(procedure, input.body),
    validatedSessionAccess: input.validatedSessionAccess,
  });
  const metadata = await requireSessionMetadata({
    env: input.env,
    userId: input.userId,
    cloudAgentSessionId,
    procedure,
  });
  const modelId = requiredModel(
    procedure === 'initiateFromKilocodeSessionV2'
      ? metadata.agent?.model
      : (requestedExistingSessionModel(procedure, input.body) ?? metadata.agent?.model)
  );
  const owner: CloudAgentModelBillingOwner = access.organizationId
    ? { organizationId: access.organizationId }
    : { userId: input.userId };
  const admission = await checkCloudAgentAdmission({
    env: input.env,
    token: input.authToken,
    modelId,
    owner,
  });
  return {
    ...admission,
    owner,
    validatedSessionAccess: {
      kiloUserId: input.userId,
      cloudAgentSessionId,
      ...access,
    },
  };
}
