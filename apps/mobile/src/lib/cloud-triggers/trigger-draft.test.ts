import { describe, expect, it } from 'vitest';

import { triggerNameProblem } from './trigger-id';
import {
  buildCreateInput,
  buildUpdateInput,
  type CloudTriggerDetail,
  createTriggerDraft,
  readBodySchema,
  type TriggerDraft,
  triggerDraftFromDetail,
  triggerDraftProblems,
} from './trigger-draft';

const TIME_ZONE = 'Europe/Belgrade';

function webhookDraft(overrides: Partial<TriggerDraft> = {}): TriggerDraft {
  return {
    ...createTriggerDraft(TIME_ZONE),
    name: 'nightly-deps',
    repository: 'kilo-org/cloud',
    model: 'anthropic/claude-sonnet-4',
    prompt: 'Describe this webhook request payload:\n\n{{body}}',
    ...overrides,
  };
}

/** The stored configuration the detail screen derives its draft from. */
function detail(overrides: Partial<CloudTriggerDetail> = {}): CloudTriggerDetail {
  return {
    triggerId: 'nightly-deps',
    namespace: 'user',
    userId: 'user-1',
    orgId: null,
    createdAt: '2026-11-16T09:00:00.000Z',
    isActive: true,
    targetType: 'cloud_agent',
    githubRepo: 'kilo-org/cloud',
    mode: 'code',
    model: 'anthropic/claude-sonnet-4',
    promptTemplate: 'Describe',
    webhookAuthConfigured: false,
    activationMode: 'webhook',
    inboundUrl: 'https://kilo.ai/api/webhooks/users/user-1/nightly-deps',
    canEdit: true,
    canEditReason: null,
    canRun: true,
    ...overrides,
  };
}

describe('readBodySchema', () => {
  it('treats an empty field as no schema', () => {
    expect(readBodySchema('   ')).toBeNull();
  });

  it('rejects text that is not a JSON object', () => {
    expect(readBodySchema('{oops')).toBeUndefined();
    expect(readBodySchema('[1, 2]')).toBeUndefined();
  });

  it('returns the parsed object', () => {
    expect(readBodySchema('{"type":"object"}')).toEqual({ type: 'object' });
  });
});

describe('triggerDraftProblems', () => {
  it('refuses a name that is shorter than a new trigger may use', () => {
    const problems = triggerDraftProblems(webhookDraft({ name: 'short' }), {
      mode: 'create',
      authConfigured: false,
    });
    expect(problems.name).toBe('tooShort');
  });

  it('accepts the same name on an existing trigger', () => {
    const problems = triggerDraftProblems(webhookDraft({ name: 'short' }), {
      mode: 'edit',
      authConfigured: true,
    });
    expect(problems.name).toBeUndefined();
  });

  it('refuses a built-in "custom" agent and an invalid slug', () => {
    expect(
      triggerDraftProblems(webhookDraft({ agent: 'custom' }), {
        mode: 'create',
        authConfigured: true,
      }).agent
    ).toBe('agentInvalid');
    expect(
      triggerDraftProblems(webhookDraft({ agent: 'Foreman' }), {
        mode: 'create',
        authConfigured: true,
      }).agent
    ).toBe('agentInvalid');
  });

  it('requires a secret only while none is stored', () => {
    const required = triggerDraftProblems(
      webhookDraft({ authEnabled: true, authHeader: 'x-secret' }),
      {
        mode: 'edit',
        authConfigured: false,
      }
    );
    const kept = triggerDraftProblems(webhookDraft({ authEnabled: true, authHeader: 'x-secret' }), {
      mode: 'edit',
      authConfigured: true,
    });
    expect(required.authSecret).toBe('authSecretRequired');
    expect(kept.authSecret).toBeUndefined();
  });

  it('checks the body schema only where the field is shown', () => {
    expect(
      triggerDraftProblems(webhookDraft({ bodySchemaJson: '{oops' }), {
        mode: 'create',
        authConfigured: false,
      }).bodySchema
    ).toBe('bodySchemaInvalid');
    expect(
      triggerDraftProblems(
        webhookDraft({ activation: 'scheduled', cron: '0 9 * * *', bodySchemaJson: '{oops' }),
        {
          mode: 'edit',
          authConfigured: false,
        }
      ).bodySchema
    ).toBeUndefined();
  });
});

describe('buildCreateInput', () => {
  it('posts a webhook trigger with its secret header and body schema', () => {
    const input = buildCreateInput(
      webhookDraft({
        authEnabled: true,
        authHeader: ' x-secret ',
        authSecret: ' super-secret-value ',
        bodySchemaJson: '{"type":"object"}',
        autoCommit: true,
      }),
      'org-1'
    );
    expect(input).toEqual({
      triggerId: 'nightly-deps',
      organizationId: 'org-1',
      activationMode: 'webhook',
      githubRepo: 'kilo-org/cloud',
      mode: 'code',
      model: 'anthropic/claude-sonnet-4',
      promptTemplate: 'Describe this webhook request payload:\n\n{{body}}',
      environmentId: null,
      profileId: null,
      bodySchema: { type: 'object' },
      autoCommit: true,
      condenseOnComplete: false,
      webhookAuth: { header: 'x-secret', secret: 'super-secret-value' },
    });
  });

  it('posts a scheduled trigger with its cron and no webhook authentication', () => {
    const input = buildCreateInput(
      webhookDraft({
        activation: 'scheduled',
        cron: ' 0 9 * * 1-5 ',
        timezone: TIME_ZONE,
        authEnabled: true,
        authHeader: 'x-secret',
        authSecret: 'super-secret-value',
      }),
      undefined
    );
    expect(input).toMatchObject({
      activationMode: 'scheduled',
      cronExpression: '0 9 * * 1-5',
      cronTimezone: TIME_ZONE,
    });
    expect(input).not.toHaveProperty('webhookAuth');
    expect(input).not.toHaveProperty('bodySchema');
  });

  it('refuses to build a payload from an unparseable body schema', () => {
    expect(buildCreateInput(webhookDraft({ bodySchemaJson: '{oops' }), undefined)).toBeNull();
  });
});

describe('buildUpdateInput', () => {
  it('clears a variant, an environment and the secret header the person removed', () => {
    const draft = triggerDraftFromDetail(detail({ environmentId: 'env-1', variant: 'high' }));
    expect(
      buildUpdateInput(
        { ...draft, variant: '', environmentId: null, authEnabled: false },
        { triggerId: 'nightly-deps', authConfigured: true }
      )
    ).toMatchObject({
      triggerId: 'nightly-deps',
      variant: null,
      environmentId: null,
      webhookAuth: { header: null, secret: null },
    });
  });

  it('keeps a stored secret when the field is left blank', () => {
    const draft = triggerDraftFromDetail(
      detail({ webhookAuthConfigured: true, webhookAuthHeader: 'x-secret' })
    );
    const input = buildUpdateInput(draft, {
      triggerId: 'nightly-deps',
      organizationId: 'org-1',
      authConfigured: true,
    });
    expect(input?.webhookAuth).toEqual({ header: 'x-secret' });
    expect(input?.organizationId).toBe('org-1');
  });
});

describe('triggerNameProblem', () => {
  it('refuses a reserved name and a name with capitals', () => {
    expect(triggerNameProblem('requests', 'edit')).toBe('reserved');
    expect(triggerNameProblem('Nightly', 'edit')).toBe('characters');
    expect(triggerNameProblem('nightly-deps', 'create')).toBeNull();
  });
});
