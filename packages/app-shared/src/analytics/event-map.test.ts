import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { SECURITY_COMMAND_TYPES } from '@kilocode/app-shared/security-agent';

import {
  ACCESS_REQUIRED_SHOWN_EVENT,
  ANALYTICS_EVENT_SCHEMAS,
  APP_STARTUP_EVENT,
  CLAW_WEATHER_LOCATION_SELECTED_EVENT,
  CLAW_WEATHER_LOCATION_SKIPPED_EVENT,
  CODE_REVIEW_SETTLED_EVENT,
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
  PERMISSION_RESPONDED_EVENT,
  PR_OPERATION_SETTLED_EVENT,
  PROVISION_FAILED_EVENT,
  PROVISION_REQUESTED_EVENT,
  PROVISION_SUCCEEDED_EVENT,
  PURCHASE_SETTLED_EVENT,
  QUESTION_ANSWERED_EVENT,
  SECURITY_COMMAND_SETTLED_EVENT,
  SECURITY_INTENT_FOR_COMMAND_TYPE,
  SECURITY_INTENTS,
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
  CODE_REVIEW_SETTLED_EVENT,
  PURCHASE_SETTLED_EVENT,
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
    expect(terminal).toHaveLength(5);
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

describe('security intent map', () => {
  it('keys the map by the shared command-type authority', () => {
    expect(new Set(Object.keys(SECURITY_INTENT_FOR_COMMAND_TYPE))).toEqual(
      new Set(SECURITY_COMMAND_TYPES)
    );
  });

  it('maps every command type to exactly one intent and covers every intent', () => {
    const commandTypes = Object.keys(SECURITY_INTENT_FOR_COMMAND_TYPE);
    const intents = Object.values(SECURITY_INTENT_FOR_COMMAND_TYPE);

    // The map is a bijection: every command type has exactly one intent and no
    // two command types share an intent.
    expect(commandTypes).toHaveLength(4);
    expect(new Set(intents).size).toBe(commandTypes.length);

    // The intents cover every SECURITY_INTENTS member. `sync` maps to
    // `manual_sync`, so an array-equality assertion between the command types
    // and the intents can never pass.
    expect(new Set(intents)).toEqual(new Set(SECURITY_INTENTS));
  });

  it('pins the exact command-to-intent pairing', () => {
    // A value swap (e.g. `sync: 'dismiss_finding'`) would pass the key-set and
    // value-set assertions above, so pin the whole map. `sync` must map to the
    // legacy ledger intent `manual_sync` that deployed producers emit.
    expect(SECURITY_INTENT_FOR_COMMAND_TYPE).toEqual({
      sync: 'manual_sync',
      dismiss_finding: 'dismiss_finding',
      start_analysis: 'start_analysis',
      apply_auto_remediation: 'apply_auto_remediation',
    });
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
      startupSchema.safeParse({
        outcome: 'app',
        auth_ready: 0,
        splash_hidden: 80,
      }).success
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
    expect(startupSchema.safeParse({ outcome: 'language-error', splash_hidden: 90 }).success).toBe(
      true
    );
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
  it('rejects prohibited keys across case, separator, acronym, and suffix variants', () => {
    for (const key of [
      // bare terms
      'email',
      'url',
      'repo',
      'prompt',
      'content',
      'token',
      'secret',
      'transaction',
      'comment',
      'message',
      // resource ids
      'session_id',
      'user_id',
      'userId',
      'repo_id',
      'stripe_invoice_id',
      'provider_transaction_id',
      // separator and case variants
      'raw_prompt',
      'Raw_Prompt',
      'rawPrompt',
      'api_token',
      'API_TOKEN',
      'apiToken',
      'password',
      'user_password',
      'passwd',
      'auth_header',
      'api_key',
      'client_credential',
      'secret_value',
      'SECRET_VALUE',
      'secretValue',
      'user_email',
      'user_message',
      'userComment',
      'Email',
      'EMAIL',
      'Comment',
      'Message',
      // letter-suffix variants
      'repository',
      'REPOSITORY',
      'Repositories',
      'emails',
      'prompts',
      'tokens',
      'secrets',
      'comments',
      'messages',
      'repos',
      // repository names and acronym camel case
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

  it('allows enum, count, duration, and event-identity keys', () => {
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
      'ok_count',
      'in_organization',
      'skipped',
      'sentiment',
      'role',
      'via',
      'event_uuid',
      'Event_UUID',
      'eventUuid',
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

  it('drops prohibited keys from a runtime payload without mutating the input', () => {
    const input = {
      surface: 'claw',
      email: 'a@b.co',
      session_id: 'x',
      repository: 'acme/app',
      repo_name: 'acme/app',
      repoName: 'acme/app',
      comment: 'lgtm',
      message: 'hello',
      Raw_Prompt: 'write tests',
      apiToken: 'tok',
      APIToken: 'tok',
      password: 'password',
      authHeader: 'Bearer token',
      api_key: 'key',
      clientCredential: 'credential',
      SecretValue: 's3cr3t',
      ok_count: 1,
      repo_count: 3,
      duration_ms: 42,
      event_uuid: 'abc',
    };
    const copy = { ...input };

    expect(redactProhibitedProperties(input)).toEqual({
      surface: 'claw',
      ok_count: 1,
      repo_count: 3,
      duration_ms: 42,
      event_uuid: 'abc',
    });
    expect(input).toEqual(copy);
  });
});
