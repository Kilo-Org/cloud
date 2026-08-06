import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  ACCESS_REQUIRED_SHOWN_EVENT,
  ANALYTICS_EVENT_SCHEMAS,
  APP_STARTUP_EVENT,
  CLAW_WEATHER_LOCATION_SELECTED_EVENT,
  CLAW_WEATHER_LOCATION_SKIPPED_EVENT,
  COMPLETION_REACHED_EVENT,
  CONVERSATION_CREATED_EVENT,
  FEEDBACK_SUBMITTED_EVENT,
  INSTANCE_ACTION_EVENT,
  KILO_PASS_PURCHASE_COMPLETED_EVENT,
  KILO_PASS_PURCHASE_FAILED_EVENT,
  KILO_PASS_PURCHASE_STARTED_EVENT,
  LEGACY_EVENT_NAMES,
  LOGIN_EVENT,
  MESSAGE_SENT_EVENT,
  ONBOARDING_ENTERED_EVENT,
  ORGANIZATION_MEMBER_INVITED_EVENT,
  ORGANIZATION_WRITE_SETTLED_EVENT,
  PERMISSION_RESPONDED_EVENT,
  PR_OPERATION_SETTLED_EVENT,
  PROVISION_FAILED_EVENT,
  PROVISION_REQUESTED_EVENT,
  PROVISION_SUCCEEDED_EVENT,
  QUESTION_ANSWERED_EVENT,
  SECURITY_COMMAND_SETTLED_EVENT,
  SESSION_CREATED_EVENT,
  SESSION_CREATE_SETTLED_EVENT,
  SESSION_VIEWED_EVENT,
  TERMINAL_PHASE_EVENTS,
  type AcceptedPhaseEventName,
  type TerminalOutcomeEventName,
} from './event-map';
import { isProhibitedPropertyKey, redactProhibitedProperties } from './privacy';

const ALL_EVENT_CONSTANTS = [
  SESSION_VIEWED_EVENT,
  MESSAGE_SENT_EVENT,
  SESSION_CREATED_EVENT,
  PERMISSION_RESPONDED_EVENT,
  QUESTION_ANSWERED_EVENT,
  CONVERSATION_CREATED_EVENT,
  INSTANCE_ACTION_EVENT,
  FEEDBACK_SUBMITTED_EVENT,
  ORGANIZATION_MEMBER_INVITED_EVENT,
  KILO_PASS_PURCHASE_STARTED_EVENT,
  KILO_PASS_PURCHASE_COMPLETED_EVENT,
  KILO_PASS_PURCHASE_FAILED_EVENT,
  APP_STARTUP_EVENT,
  ONBOARDING_ENTERED_EVENT,
  PROVISION_REQUESTED_EVENT,
  PROVISION_SUCCEEDED_EVENT,
  PROVISION_FAILED_EVENT,
  ACCESS_REQUIRED_SHOWN_EVENT,
  COMPLETION_REACHED_EVENT,
  CLAW_WEATHER_LOCATION_SELECTED_EVENT,
  CLAW_WEATHER_LOCATION_SKIPPED_EVENT,
  LOGIN_EVENT,
  SESSION_CREATE_SETTLED_EVENT,
  PR_OPERATION_SETTLED_EVENT,
  SECURITY_COMMAND_SETTLED_EVENT,
  ORGANIZATION_WRITE_SETTLED_EVENT,
];

type ZodDefProbe = {
  type?: string;
  shape?: Record<string, unknown>;
  catchall?: { _def?: { type?: string } };
};

function defOf(schema: z.ZodType): ZodDefProbe {
  return (schema as unknown as { _def: ZodDefProbe })._def;
}

describe('ANALYTICS_EVENT_SCHEMAS', () => {
  it('covers every exported event constant', () => {
    for (const name of ALL_EVENT_CONSTANTS) {
      expect(ANALYTICS_EVENT_SCHEMAS, `missing schema for ${name}`).toHaveProperty(name);
    }
    expect(Object.keys(ANALYTICS_EVENT_SCHEMAS)).toHaveLength(ALL_EVENT_CONSTANTS.length);
  });

  it('defines every schema as a strict object', () => {
    for (const [name, schema] of Object.entries(ANALYTICS_EVENT_SCHEMAS)) {
      const def = defOf(schema);
      expect(def.type, `${name} must be an object schema`).toBe('object');
      // zod v4 represents `.strict()` as a `never` catchall on the object.
      expect(def.catchall?._def?.type, `${name} must use .strict()`).toBe('never');
    }
  });

  it('rejects unknown keys on every object schema', () => {
    for (const [name, schema] of Object.entries(ANALYTICS_EVENT_SCHEMAS)) {
      const def = defOf(schema);
      if (def.type !== 'object' || !def.shape) {
        continue;
      }
      const shape = def.shape as Record<string, z.ZodType>;
      const valid = Object.fromEntries(
        Object.entries(shape).map(([key, value]) => [key, sampleValue(value)])
      );
      expect(schema.safeParse(valid).success, `${name} valid payload`).toBe(true);
      expect(
        schema.safeParse({ ...valid, unexpected_key: 'x' }).success,
        `${name} must reject unknown keys`
      ).toBe(false);
    }
  });
});

/** Builds a value each schema accepts, used to probe unknown-key rejection. */
function sampleValue(schema: z.ZodType): unknown {
  const def = defOf(schema);
  switch (def.type) {
    case 'enum': {
      const entries = (schema as unknown as { _def: { entries?: Record<string, string> } })._def
        .entries;
      return entries ? Object.values(entries)[0] : undefined;
    }
    case 'literal':
      return (schema as unknown as { _def: { values?: readonly unknown[] } })._def.values?.[0];
    case 'boolean':
      return true;
    case 'number':
      return 0;
    case 'string':
      return 'x';
    case 'optional': {
      const inner = (schema as unknown as { _def: { innerType: z.ZodType } })._def.innerType;
      return sampleValue(inner);
    }
    default:
      throw new Error(`sampleValue does not know schema type ${String(def.type)}`);
  }
}

describe('event name rules', () => {
  const SNAKE_CASE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

  it('uses snake_case for every event name outside the frozen legacy set', () => {
    for (const name of Object.keys(ANALYTICS_EVENT_SCHEMAS)) {
      if (LEGACY_EVENT_NAMES.has(name)) {
        continue;
      }
      expect(name, `${name} must be snake_case`).toMatch(SNAKE_CASE);
    }
  });

  it('freezes LEGACY_EVENT_NAMES to the kebab-case KiloClaw onboarding names', () => {
    expect(LEGACY_EVENT_NAMES).toEqual(
      new Set([
        ONBOARDING_ENTERED_EVENT,
        PROVISION_REQUESTED_EVENT,
        PROVISION_SUCCEEDED_EVENT,
        PROVISION_FAILED_EVENT,
        ACCESS_REQUIRED_SHOWN_EVENT,
        COMPLETION_REACHED_EVENT,
        CLAW_WEATHER_LOCATION_SELECTED_EVENT,
        CLAW_WEATHER_LOCATION_SKIPPED_EVENT,
      ])
    );
  });
});

describe('phase classification', () => {
  it('classifies every settled event as terminal and the rest as accepted', () => {
    const terminal: TerminalOutcomeEventName[] = [...TERMINAL_PHASE_EVENTS];
    const accepted: AcceptedPhaseEventName[] = [
      SESSION_CREATED_EVENT,
      KILO_PASS_PURCHASE_COMPLETED_EVENT,
      APP_STARTUP_EVENT,
    ];
    expect(terminal).toHaveLength(4);
    for (const name of TERMINAL_PHASE_EVENTS) {
      expect(ANALYTICS_EVENT_SCHEMAS).toHaveProperty(name);
    }
    // session_created is accepted-phase metadata, never a terminal outcome.
    expect(TERMINAL_PHASE_EVENTS).not.toContain(SESSION_CREATED_EVENT);
    expect(accepted.length).toBeGreaterThan(0);
  });

  it('gives every terminal schema the DEC-05 base fields', () => {
    for (const name of TERMINAL_PHASE_EVENTS) {
      const schema = ANALYTICS_EVENT_SCHEMAS[name];
      const shape = defOf(schema).shape ?? {};
      expect(Object.keys(shape), name).toEqual(
        expect.arrayContaining(['source', 'surface', 'phase', 'outcome'])
      );
      expect(schema.safeParse({ phase: 'accepted' }).success).toBe(false);
    }
  });
});

describe('organization_member_invited role schema', () => {
  const invitedSchema = ANALYTICS_EVENT_SCHEMAS[ORGANIZATION_MEMBER_INVITED_EVENT];

  it('accepts every current organization role payload', () => {
    for (const role of ['owner', 'admin', 'member', 'billing_manager']) {
      expect(invitedSchema.safeParse({ role }).success, `role=${role}`).toBe(true);
    }
  });

  it('rejects an unknown role payload', () => {
    expect(invitedSchema.safeParse({ role: 'superadmin' }).success).toBe(false);
  });
});

describe('app_startup validation', () => {
  const startupSchema = ANALYTICS_EVENT_SCHEMAS[APP_STARTUP_EVENT];

  it('accepts the current takeStartupTimings() payload shape', () => {
    expect(
      startupSchema.safeParse({ outcome: 'app', auth_ready: 0, splash_hidden: 80 }).success
    ).toBe(true);
    expect(
      startupSchema.safeParse({
        outcome: 'force-update',
        auth_ready: 12,
        fonts_ready: 30,
        theme_ready: 40,
        user_ready: 55,
        consent_ready: 70,
        splash_hidden: 85,
      }).success
    ).toBe(true);
  });

  it('rejects an invalid startup outcome', () => {
    expect(startupSchema.safeParse({ outcome: 'invalid' }).success).toBe(false);
    expect(startupSchema.safeParse({ outcome: 'APP' }).success).toBe(false);
    expect(startupSchema.safeParse({ outcome: 'app', auth_ready: 12, email: 'raw' }).success).toBe(
      false
    );
  });

  it('rejects unknown keys, including the privacy deny-list example', () => {
    expect(startupSchema.safeParse({ email: 'raw', outcome: 'invalid' }).success).toBe(false);
    expect(startupSchema.safeParse({ outcome: 'app', unexpected_key: 1 }).success).toBe(false);
  });

  it('rejects non-numeric timing values', () => {
    expect(startupSchema.safeParse({ outcome: 'app', auth_ready: 'slow' }).success).toBe(false);
    expect(startupSchema.safeParse({ outcome: 'app', splash_hidden: true }).success).toBe(false);
  });
});

describe('privacy deny-list', () => {
  it('rejects prohibited property keys and allows event_uuid', () => {
    for (const key of [
      'email',
      'url',
      'repo',
      'prompt',
      'content',
      'token',
      'secret',
      'transaction',
      'session_id',
      'user_id',
      'repo_id',
      'stripe_invoice_id',
      'provider_transaction_id',
    ]) {
      expect(isProhibitedPropertyKey(key), key).toBe(true);
    }
    expect(isProhibitedPropertyKey('event_uuid')).toBe(false);
  });

  it('allows allowed enum, count, and duration keys', () => {
    for (const key of [
      'source',
      'surface',
      'phase',
      'outcome',
      'intent',
      'admission',
      'duration_ms',
      'repo_count',
      'error_count',
      'in_organization',
      'skipped',
      'sentiment',
      'role',
      'via',
    ]) {
      expect(isProhibitedPropertyKey(key), key).toBe(false);
    }
  });

  it('walks every schema property key and finds none prohibited', () => {
    for (const [name, schema] of Object.entries(ANALYTICS_EVENT_SCHEMAS)) {
      const def = defOf(schema);
      if (def.type !== 'object' || !def.shape) {
        continue;
      }
      for (const key of Object.keys(def.shape)) {
        expect(isProhibitedPropertyKey(key), `${name}.${key}`).toBe(false);
      }
    }
  });

  it('keeps the app_startup payload keys deny-list clean', () => {
    const payload: Record<string, string | number> = {
      outcome: 'app',
      auth_ready: 0,
      fonts_ready: 12,
      theme_ready: 20,
      user_ready: 45,
      consent_ready: 60,
      splash_hidden: 80,
    };
    for (const key of Object.keys(payload)) {
      expect(isProhibitedPropertyKey(key), key).toBe(false);
    }
    expect(redactProhibitedProperties(payload)).toEqual(payload);
  });

  it('drops prohibited keys from an uncataloged runtime payload', () => {
    const input = { surface: 'claw', email: 'a@b.co', session_id: 'x', ok_count: 1 };
    expect(redactProhibitedProperties(input)).toEqual({ surface: 'claw', ok_count: 1 });
    expect(input).toEqual({ surface: 'claw', email: 'a@b.co', session_id: 'x', ok_count: 1 });
  });

  it('blocks the named variant examples', () => {
    for (const key of [
      'repository',
      'comment',
      'message',
      'raw_prompt',
      'api_token',
      'secret_value',
    ]) {
      expect(isProhibitedPropertyKey(key), key).toBe(true);
    }
  });

  it('blocks common case, separator, and suffix variants', () => {
    for (const key of [
      'Email',
      'EMAIL',
      'REPOSITORY',
      'Repositories',
      'Raw_Prompt',
      'rawPrompt',
      'API_TOKEN',
      'apiToken',
      'SECRET_VALUE',
      'secretValue',
      'Comment',
      'userComment',
      'Message',
      'user_message',
      'emails',
      'user_email',
      'prompts',
      'tokens',
      'secrets',
      'comments',
      'messages',
      'repos',
      'provider_transaction_id',
      'userId',
      'session_id',
    ]) {
      expect(isProhibitedPropertyKey(key), key).toBe(true);
    }
  });

  it('blocks repository-name and acronym camel-case variants', () => {
    for (const key of [
      'repo_name',
      'repoName',
      'RepositoryName',
      'repo_url',
      'APIToken',
      'ApiToken',
      'OAuthToken',
    ]) {
      expect(isProhibitedPropertyKey(key), key).toBe(true);
    }
  });

  it('keeps allowed catalog fields allowed across case variants', () => {
    for (const key of [
      'repo_count',
      'error_count',
      'duration_ms',
      'event_uuid',
      'Event_UUID',
      'eventUuid',
      'ok_count',
    ]) {
      expect(isProhibitedPropertyKey(key), key).toBe(false);
    }
  });

  it('redacts the named variants while keeping allowed catalog fields', () => {
    const input = {
      surface: 'claw',
      repository: 'acme/app',
      comment: 'lgtm',
      message: 'hello',
      raw_prompt: 'write tests',
      api_token: 'tok',
      secret_value: 's3cr3t',
      repo_count: 3,
      duration_ms: 42,
      event_uuid: 'abc',
    };
    expect(redactProhibitedProperties(input)).toEqual({
      surface: 'claw',
      repo_count: 3,
      duration_ms: 42,
      event_uuid: 'abc',
    });
  });

  it('redacts case and camelCase variants at runtime', () => {
    const input = { Raw_Prompt: 'x', apiToken: 'y', SecretValue: 'z', ok_count: 1 };
    expect(redactProhibitedProperties(input)).toEqual({ ok_count: 1 });
  });

  it('redacts the repaired repository and acronym variants at runtime', () => {
    const input = {
      repo_name: 'acme/app',
      repoName: 'acme/app',
      repository: 'acme/app',
      APIToken: 'tok',
      repo_count: 3,
      duration_ms: 42,
      event_uuid: 'abc',
    };
    expect(redactProhibitedProperties(input)).toEqual({
      repo_count: 3,
      duration_ms: 42,
      event_uuid: 'abc',
    });
  });
});
