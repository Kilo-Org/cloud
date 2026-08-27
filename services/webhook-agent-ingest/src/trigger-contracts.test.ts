import { describe, expect, it } from 'vitest';
import { TriggerConfigInput, TriggerConfigUpdateInput } from './routes/api';
import { WebhookDeliveryMessageSchema } from './util/queue';

const githubIntegrationId = '123e4567-e89b-12d3-a456-426614174022';

describe('webhook trigger contracts', () => {
  it('accepts an optional GitHub integration on create and edit', () => {
    expect(
      TriggerConfigInput.safeParse({
        organizationId: '123e4567-e89b-12d3-a456-426614174025',
        githubRepo: 'acme/repository',
        githubIntegrationId,
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: '{{body}}',
        profileId: '123e4567-e89b-12d3-a456-426614174023',
      }).success
    ).toBe(true);
    expect(TriggerConfigUpdateInput.safeParse({ githubIntegrationId }).success).toBe(true);
  });

  it('rejects malformed or inapplicable integration identities', () => {
    expect(TriggerConfigUpdateInput.safeParse({ githubIntegrationId: 'not-a-uuid' }).success).toBe(
      false
    );
    expect(
      TriggerConfigInput.safeParse({
        targetType: 'kiloclaw_chat',
        kiloclawInstanceId: '123e4567-e89b-12d3-a456-426614174024',
        githubIntegrationId,
        promptTemplate: '{{body}}',
      }).success
    ).toBe(false);
  });

  it('keeps legacy queue payloads readable and accepts the selected integration snapshot', () => {
    const legacyMessage = {
      namespace: 'org/123e4567-e89b-12d3-a456-426614174025',
      triggerId: 'deploy-main',
      requestId: 'request-1',
    };

    expect(WebhookDeliveryMessageSchema.parse(legacyMessage)).toEqual(legacyMessage);
    expect(WebhookDeliveryMessageSchema.parse({ ...legacyMessage, githubIntegrationId })).toEqual({
      ...legacyMessage,
      githubIntegrationId,
    });
  });
});
