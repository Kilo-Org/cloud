jest.mock('./settings', () => ({
  getRuntimeAnthropicUserProfilesSettings: jest.fn(),
}));

import { beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { AnthropicUserProfilesSettingsSchema } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { createOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { getRuntimeAnthropicUserProfilesSettings } from './settings';
import { isAnthropicUserProfileRoute, resolveGatewayAnthropicUserProfile } from './gateway';

const CLAUDE = 'anthropic/claude-sonnet-4.5';
const user = { id: 'user-1', anthropic_user_profile_id: 'uprof_user' };

describe('resolveGatewayAnthropicUserProfile', () => {
  beforeEach(() => {
    jest.mocked(getRuntimeAnthropicUserProfilesSettings).mockResolvedValue(
      AnthropicUserProfilesSettingsSchema.parse({
        enabled: true,
        start_at: '2026-01-01T00:00:00Z',
      })
    );
  });

  it('skips other models and a disabled feature', async () => {
    expect(
      await resolveGatewayAnthropicUserProfile({
        model: 'openai/gpt-5',
        user,
        organizationId: undefined,
      })
    ).toBeNull();
    jest
      .mocked(getRuntimeAnthropicUserProfilesSettings)
      .mockResolvedValue(AnthropicUserProfilesSettingsSchema.parse({}));
    expect(
      await resolveGatewayAnthropicUserProfile({ model: CLAUDE, user, organizationId: undefined })
    ).toBeNull();
  });

  it("uses the user's profile for personal traffic", async () => {
    expect(
      await resolveGatewayAnthropicUserProfile({ model: CLAUDE, user, organizationId: undefined })
    ).toEqual({
      userProfileId: 'uprof_user',
      subject: { kind: 'user', userId: 'user-1' },
      create: true,
    });
  });

  it("uses the organization's profile and parent for organization traffic", async () => {
    const parent = await createOrganization(`Parent ${randomUUID()}`);
    const child = await createOrganization(`Child ${randomUUID()}`);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id, anthropic_user_profile_id: 'uprof_parent' })
      .where(eq(organizations.id, child.id));
    expect(
      await resolveGatewayAnthropicUserProfile({ model: CLAUDE, user, organizationId: child.id })
    ).toEqual({
      userProfileId: 'uprof_parent',
      subject: { kind: 'organization', organizationId: child.id, rootOrganizationId: parent.id },
      create: true,
    });
  });
});

describe('isAnthropicUserProfileRoute', () => {
  it('accepts only Kilo-paid routes', () => {
    const route = (type: string, userByok: null | [] = null) =>
      ({ provider: { type }, userByok }) as never;
    expect(isAnthropicUserProfileRoute(route('openrouter'))).toBe(true);
    expect(isAnthropicUserProfileRoute(route('custom'))).toBe(true);
    expect(isAnthropicUserProfileRoute(route('vercel', []))).toBe(false);
    expect(isAnthropicUserProfileRoute(route('claude-billing'))).toBe(false);
    expect(isAnthropicUserProfileRoute(route('openai-chatgpt'))).toBe(false);
  });
});
