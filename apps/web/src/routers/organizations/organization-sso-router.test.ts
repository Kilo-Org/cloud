import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { kilocode_users, organizations, type Organization, type User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { createOrganization } from '@/lib/organizations/organizations';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';

describe('organization SSO router', () => {
  let admin: User;
  let sameDomainUser: User;
  let sameDomainBot: User;
  let organization: Organization;

  beforeAll(async () => {
    admin = await insertTestUser({
      google_user_email: 'sso-admin@admin.example.com',
      is_admin: true,
    });
    sameDomainUser = await insertTestUser({
      google_user_email: 'member@example.com',
      api_token_pepper: 'old-api-pepper',
      web_session_pepper: 'old-web-pepper',
    });
    sameDomainBot = await insertTestUser({
      google_user_email: 'bot@example.com',
      api_token_pepper: 'bot-api-pepper',
      web_session_pepper: 'bot-web-pepper',
      is_bot: true,
    });
    organization = await createOrganization('SSO Router Organization', admin.id);
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, organization.id));
  });

  test('rotates same-domain human credentials when SSO is enabled', async () => {
    const caller = await createCallerForUser(admin.id);

    await caller.organizations.sso.updateSsoDomain({
      organizationId: organization.id,
      ssoDomain: 'example.com',
    });

    const updatedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, sameDomainUser.id),
    });
    const unchangedBot = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, sameDomainBot.id),
    });

    expect(updatedUser?.api_token_pepper).not.toBe('old-api-pepper');
    expect(updatedUser?.web_session_pepper).not.toBe('old-web-pepper');
    expect(unchangedBot?.api_token_pepper).toBe('bot-api-pepper');
    expect(unchangedBot?.web_session_pepper).toBe('bot-web-pepper');
  });
});
