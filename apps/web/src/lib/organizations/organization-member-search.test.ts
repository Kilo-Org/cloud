import { eq } from 'drizzle-orm';
import { organizations, type Organization, type User } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  addUserToOrganization,
  createOrganization,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  findOrganizationMembers,
  ORGANIZATION_MEMBER_SEARCH_LIMIT,
  OrganizationMemberSearchQuerySchema,
} from './organization-member-search';

async function memberOf(organization: Organization, userData: Partial<User>): Promise<User> {
  const user = await insertTestUser(userData);
  await addUserToOrganization(organization.id, user.id, 'member');
  return user;
}

async function organizationWithOwner(): Promise<{ organization: Organization; owner: User }> {
  const owner = await insertTestUser({ google_user_name: 'Olive Owner' });
  const organization = await createOrganization(`Org ${crypto.randomUUID()}`, owner.id);
  return { organization, owner };
}

const names = (members: { name: string }[] | null) => members?.map(member => member.name);

describe('findOrganizationMembers', () => {
  describe('who may search', () => {
    it('lets a direct member search', async () => {
      const { organization, owner } = await organizationWithOwner();
      const searcher = await memberOf(organization, { google_user_name: 'Sam Searcher' });

      expect(
        names(await findOrganizationMembers(searcher.id, organization.id, { query: 'ol' }))
      ).toEqual(['Olive Owner']);
      expect(await findOrganizationMembers(owner.id, organization.id, { query: 'sa' })).not.toBe(
        null
      );
    });

    it('refuses a person with no membership', async () => {
      const { organization } = await organizationWithOwner();
      const outsider = await insertTestUser();

      expect(await findOrganizationMembers(outsider.id, organization.id, { query: 'ol' })).toBe(
        null
      );
    });

    it('refuses a Kilo admin who is not a member', async () => {
      const { organization } = await organizationWithOwner();
      const kiloAdmin = await insertTestUser({ is_admin: true });

      expect(await findOrganizationMembers(kiloAdmin.id, organization.id, { query: 'ol' })).toBe(
        null
      );
    });

    it('refuses an owner of the parent organization who is not in the child', async () => {
      const { organization: parent, owner: parentOwner } = await organizationWithOwner();
      const { organization: child } = await organizationWithOwner();
      await db
        .update(organizations)
        .set({ parent_organization_id: parent.id })
        .where(eq(organizations.id, child.id));

      expect(await findOrganizationMembers(parentOwner.id, child.id, { query: 'ol' })).toBe(null);
    });

    it('refuses a blocked member', async () => {
      const { organization } = await organizationWithOwner();
      const blocked = await memberOf(organization, {
        blocked_at: new Date().toISOString(),
        blocked_reason: 'test',
      });

      expect(await findOrganizationMembers(blocked.id, organization.id, { query: 'ol' })).toBe(
        null
      );
    });

    it('refuses a member of a deleted organization', async () => {
      const { organization, owner } = await organizationWithOwner();
      await db
        .update(organizations)
        .set({ deleted_at: new Date().toISOString() })
        .where(eq(organizations.id, organization.id));

      expect(await findOrganizationMembers(owner.id, organization.id, { query: 'ol' })).toBe(null);
    });
  });

  describe('search', () => {
    it('matches a case-insensitive prefix of any word, not the middle of one', async () => {
      const { organization, owner } = await organizationWithOwner();
      await memberOf(organization, { google_user_name: 'Jessica Alvarez' });
      await memberOf(organization, { google_user_name: 'Ana Jessup' });
      await memberOf(organization, { google_user_name: 'Majesty Tic' });

      expect(
        names(await findOrganizationMembers(owner.id, organization.id, { query: 'JES' }))
      ).toEqual(['Ana Jessup', 'Jessica Alvarez']);
    });

    it('returns only id, name and image, with a missing image as null', async () => {
      const { organization, owner } = await organizationWithOwner();
      const withImage = await memberOf(organization, {
        google_user_name: 'Pat Picture',
        google_user_image_url: 'https://example.com/pat.png',
      });
      const withoutImage = await memberOf(organization, {
        google_user_name: 'Pat Plain',
        google_user_image_url: '',
      });

      expect(await findOrganizationMembers(owner.id, organization.id, { query: 'pat' })).toEqual([
        { id: withImage.id, name: 'Pat Picture', image_url: 'https://example.com/pat.png' },
        { id: withoutImage.id, name: 'Pat Plain', image_url: null },
      ]);
    });

    it('leaves out bots, blocked accounts and other organizations', async () => {
      const { organization, owner } = await organizationWithOwner();
      const { organization: elsewhere } = await organizationWithOwner();
      await memberOf(organization, { google_user_name: 'Robin Active' });
      await memberOf(organization, { google_user_name: 'Robin Bot', is_bot: true });
      await memberOf(organization, {
        google_user_name: 'Robin Blocked',
        blocked_at: new Date().toISOString(),
      });
      await memberOf(organization, {
        google_user_name: 'Robin Reason',
        blocked_reason: 'abuse',
      });
      await memberOf(elsewhere, { google_user_name: 'Robin Elsewhere' });

      expect(
        names(await findOrganizationMembers(owner.id, organization.id, { query: 'rob' }))
      ).toEqual(['Robin Active']);
    });

    it('never matches or returns a name holding an address', async () => {
      const { organization, owner } = await organizationWithOwner();
      await memberOf(organization, { google_user_name: 'kim@example.com' });
      await memberOf(organization, { google_user_name: 'kim＠example.com' });
      await memberOf(organization, { google_user_name: 'Kim Real' });

      expect(
        names(await findOrganizationMembers(owner.id, organization.id, { query: 'kim' }))
      ).toEqual(['Kim Real']);
      expect(
        await findOrganizationMembers(owner.id, organization.id, { query: 'example.com' })
      ).toEqual([]);
    });

    it('never returns an empty or blank name', async () => {
      const { organization, owner } = await organizationWithOwner();
      const empty = await memberOf(organization, { google_user_name: '' });
      const blank = await memberOf(organization, { google_user_name: '   ' });

      expect(
        await findOrganizationMembers(owner.id, organization.id, { memberId: empty.id })
      ).toEqual([]);
      expect(
        await findOrganizationMembers(owner.id, organization.id, { memberId: blank.id })
      ).toEqual([]);
    });

    it('treats %, _ and \\ in the query as literal characters', async () => {
      const { organization, owner } = await organizationWithOwner();
      await memberOf(organization, { google_user_name: 'Jade Wildcard' });
      await memberOf(organization, { google_user_name: 'J_ Literal' });
      await memberOf(organization, { google_user_name: 'J\\ Backslash' });

      expect(await findOrganizationMembers(owner.id, organization.id, { query: 'J%' })).toEqual([]);
      expect(
        names(await findOrganizationMembers(owner.id, organization.id, { query: 'J_' }))
      ).toEqual(['J_ Literal']);
      expect(
        names(await findOrganizationMembers(owner.id, organization.id, { query: 'J\\' }))
      ).toEqual(['J\\ Backslash']);
    });

    it(`answers at most ${ORGANIZATION_MEMBER_SEARCH_LIMIT}, ordered by name`, async () => {
      const { organization, owner } = await organizationWithOwner();
      const all = Array.from({ length: 12 }, (_, i) => `Lee ${String(i).padStart(2, '0')}`);
      for (const name of [...all].reverse()) {
        await memberOf(organization, { google_user_name: name });
      }

      expect(
        names(await findOrganizationMembers(owner.id, organization.id, { query: 'lee' }))
      ).toEqual(all.slice(0, ORGANIZATION_MEMBER_SEARCH_LIMIT));
    });
  });

  describe('resolve by id', () => {
    it('confirms an active member and nobody else', async () => {
      const { organization, owner } = await organizationWithOwner();
      const { organization: elsewhere } = await organizationWithOwner();
      const member = await memberOf(organization, { google_user_name: 'Morgan Member' });
      const blocked = await memberOf(organization, {
        google_user_name: 'Morgan Blocked',
        blocked_at: new Date().toISOString(),
      });
      const outsider = await memberOf(elsewhere, { google_user_name: 'Morgan Outside' });

      expect(
        await findOrganizationMembers(owner.id, organization.id, { memberId: member.id })
      ).toEqual([
        { id: member.id, name: 'Morgan Member', image_url: member.google_user_image_url },
      ]);
      expect(
        await findOrganizationMembers(owner.id, organization.id, { memberId: blocked.id })
      ).toEqual([]);
      expect(
        await findOrganizationMembers(owner.id, organization.id, { memberId: outsider.id })
      ).toEqual([]);
    });
  });
});

describe('OrganizationMemberSearchQuerySchema', () => {
  it.each([
    ['  jo  ', 'jo'],
    ['x'.repeat(100), 'x'.repeat(100)],
  ])('accepts %j as %j', (query, expected) => {
    expect(OrganizationMemberSearchQuerySchema.parse(query)).toBe(expected);
  });

  it.each(['', 'j', '  j  ', 'x'.repeat(101)])('refuses %j', query => {
    expect(OrganizationMemberSearchQuerySchema.safeParse(query).success).toBe(false);
  });
});
