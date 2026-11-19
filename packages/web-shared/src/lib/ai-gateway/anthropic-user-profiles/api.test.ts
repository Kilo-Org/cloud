import { describe, expect, it } from '@jest/globals';
import { anthropicUserProfileCreateParams, anthropicUserProfileEmailHash } from './api';

describe('anthropicUserProfileCreateParams', () => {
  it('registers a user as a passthrough individual without a name', () => {
    const params = anthropicUserProfileCreateParams(
      {
        kind: 'user',
        userId: 'oauth/github:1',
        email: ' Person@Example.com ',
        createdAt: '2026-04-29 01:16:12.945+00',
      },
      'pepper'
    );
    expect(params).toEqual({
      access_type: 'passthrough',
      metadata: { kilo_source: 'ai_gateway', kilo_entity: 'user' },
      external_user_details: {
        reference_id: 'oauth/github:1',
        entity_type: 'individual',
        account_status: 'active',
        onboarded_at: '2026-04-29T01:16:12.945Z',
        email_hash: anthropicUserProfileEmailHash('person@example.com', 'pepper'),
      },
    });
    expect(params.name).toBeUndefined();
  });

  it('keys the email hash with the pepper and omits it without one', () => {
    const hash = anthropicUserProfileEmailHash(' Person@Example.com ', 'pepper');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(anthropicUserProfileEmailHash('person@example.com', 'pepper'));
    expect(hash).not.toBe(anthropicUserProfileEmailHash('person@example.com', 'other'));
    const details = {
      kind: 'user',
      userId: 'u',
      email: 'person@example.com',
      createdAt: '2026-04-29T01:16:12.945Z',
    } as const;
    expect(
      anthropicUserProfileCreateParams(details, undefined).external_user_details
    ).not.toHaveProperty('email_hash');
  });

  it('registers an organization as a named passthrough business', () => {
    expect(
      anthropicUserProfileCreateParams({
        kind: 'organization',
        organizationId: 'org-id',
        name: 'Acme',
        createdAt: '2026-04-29T01:16:12.945Z',
      })
    ).toMatchObject({
      access_type: 'passthrough',
      name: 'Acme',
      external_user_details: { reference_id: 'org-id', entity_type: 'business' },
    });
  });
});
