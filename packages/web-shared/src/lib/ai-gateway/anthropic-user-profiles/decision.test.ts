import { describe, expect, it } from '@jest/globals';
import {
  AnthropicUserProfilesSettingsInputSchema,
  AnthropicUserProfilesSettingsSchema,
  type AnthropicUserProfilesSettings,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { decideAnthropicUserProfile } from './decision';

const ORG = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-19T12:00:00Z');

function settings(overrides: Partial<AnthropicUserProfilesSettings> = {}) {
  return { ...AnthropicUserProfilesSettingsSchema.parse({ enabled: true }), ...overrides };
}

const user = { kind: 'user', userId: 'oauth/github:1' } as const;
const childOrganization = {
  kind: 'organization',
  organizationId: CHILD,
  rootOrganizationId: ORG,
} as const;

describe('decideAnthropicUserProfile', () => {
  it('does nothing while disabled, even for opted-in subjects', () => {
    expect(
      decideAnthropicUserProfile(
        settings({ enabled: false, opted_in_user_ids: [user.userId] }),
        user,
        NOW
      )
    ).toEqual({ attribute: false, create: false });
  });

  it('creates only for opt-ins when enabled without a start date', () => {
    expect(decideAnthropicUserProfile(settings(), user, NOW)).toEqual({
      attribute: true,
      create: false,
    });
    expect(
      decideAnthropicUserProfile(settings({ opted_in_user_ids: [user.userId] }), user, NOW)
    ).toEqual({ attribute: true, create: true });
  });

  it('waits for the start date unless opted in', () => {
    const future = settings({ start_at: '2026-12-01T00:00:00Z' });
    expect(decideAnthropicUserProfile(future, user, NOW)).toEqual({
      attribute: true,
      create: false,
    });
    expect(
      decideAnthropicUserProfile({ ...future, opted_in_user_ids: [user.userId] }, user, NOW)
    ).toEqual({ attribute: true, create: true });
    expect(
      decideAnthropicUserProfile(settings({ start_at: '2026-11-01T00:00:00Z' }), user, NOW).create
    ).toBe(true);
  });

  it('lets a sub-organization follow its parent and an opt-out win', () => {
    const future = settings({ start_at: '2026-12-01T00:00:00Z', opted_in_organization_ids: [ORG] });
    expect(decideAnthropicUserProfile(future, childOrganization, NOW).create).toBe(true);
    expect(
      decideAnthropicUserProfile(
        { ...future, opted_out_organization_ids: [ORG] },
        childOrganization,
        NOW
      )
    ).toEqual({ attribute: false, create: false });
  });
});

describe('AnthropicUserProfilesSettingsInputSchema', () => {
  const input = {
    revision: 0,
    enabled: true,
    start_at: null,
    opted_in_user_ids: ['a'],
    opted_in_organization_ids: [ORG.toUpperCase()],
    opted_out_user_ids: [],
    opted_out_organization_ids: [],
  };

  it('normalizes organization ids', () => {
    expect(AnthropicUserProfilesSettingsInputSchema.parse(input).opted_in_organization_ids).toEqual(
      [ORG]
    );
  });

  it('rejects a subject that is both opted in and opted out', () => {
    expect(
      AnthropicUserProfilesSettingsInputSchema.safeParse({ ...input, opted_out_user_ids: ['a'] })
        .success
    ).toBe(false);
    expect(
      AnthropicUserProfilesSettingsInputSchema.safeParse({
        ...input,
        opted_out_organization_ids: [ORG],
      }).success
    ).toBe(false);
  });

  it('parses a stored configuration without the section', () => {
    expect(AnthropicUserProfilesSettingsSchema.parse({}).enabled).toBe(false);
  });
});
