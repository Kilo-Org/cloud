import { describe, test, expect, afterEach } from '@jest/globals';
import { db, sql } from '@/lib/drizzle';
import { organizations, organization_seats_purchases, organization_invitations } from '@/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  getUserOrganizationsWithSeats,
  createOrganization,
  addUserToOrganization,
  inviteUserToOrganization,
} from './organizations';
import { getMostRecentSeatPurchase, getOrganizationSeatUsage } from './organization-seats';

describe('getUserOrganizationsWithSeats', () => {
  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
  });

  test('should return empty array when user has no organizations', async () => {
    const user = await insertTestUser();

    const result = await getUserOrganizationsWithSeats(user.id);

    expect(result).toEqual([]);
  });

  test('should return organization with zero seats when no seat purchases exist', async () => {
    const user = await insertTestUser();
    const orgName = 'Test Organization';

    const organization = await createOrganization(orgName, user.id);
    const result = await getUserOrganizationsWithSeats(user.id);

    expect(result).toHaveLength(1);
    expect(result[0].organizationId).toBe(organization.id);
    expect(result[0].organizationName).toBe(orgName);
    expect(result[0].role).toBe('owner');
    expect(result[0].memberCount).toBe(1);
    expect(result[0].balance).toBe(0);
    expect(result[0].seatCount).toEqual({
      used: 1,
      total: 0,
    });
  });

  test('should return organization with correct seat count from most recent purchase', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    // Create seat purchase
    await db.insert(organization_seats_purchases).values({
      subscription_stripe_id: 'sub_test123',
      organization_id: organization.id,
      starts_at: new Date().toISOString(),
      seat_count: 5,
      amount_usd: 50.0,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days from now
    });

    // Update organization seat_count to match the purchase
    await db
      .update(organizations)
      .set({ seat_count: 5 })
      .where(sql`${organizations.id} = ${organization.id}`);

    const result = await getUserOrganizationsWithSeats(user.id);

    expect(result).toHaveLength(1);
    expect(result[0].seatCount).toEqual({
      used: 1, // Only the owner
      total: 5,
    });
  });

  test('should use most recent seat purchase when multiple purchases exist', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    // Create older seat purchase
    await db.insert(organization_seats_purchases).values({
      subscription_stripe_id: 'sub_old123',
      starts_at: new Date().toISOString(),
      organization_id: organization.id,
      seat_count: 3,
      amount_usd: 30.0,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: sql`NOW() - INTERVAL '1 day'`, // 1 day ago
    });

    // Create newer seat purchase
    await db.insert(organization_seats_purchases).values({
      subscription_stripe_id: 'sub_new123',
      starts_at: new Date().toISOString(),
      organization_id: organization.id,
      seat_count: 10,
      amount_usd: 100.0,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Update organization seat_count to match the most recent purchase
    await db
      .update(organizations)
      .set({ seat_count: 10 })
      .where(sql`${organizations.id} = ${organization.id}`);

    const result = await getUserOrganizationsWithSeats(user.id);

    expect(result).toHaveLength(1);
    expect(result[0].seatCount).toEqual({
      used: 1,
      total: 10, // Should use the most recent purchase
    });
  });

  test('should correctly count used seats with multiple members', async () => {
    const owner = await insertTestUser();
    const member1 = await insertTestUser();
    const member2 = await insertTestUser();
    const organization = await createOrganization('Test Org', owner.id);

    // Add members to organization
    await addUserToOrganization(organization.id, member1.id, 'member');
    await addUserToOrganization(organization.id, member2.id, 'owner');

    // Create seat purchase
    await db.insert(organization_seats_purchases).values({
      subscription_stripe_id: 'sub_test123',
      starts_at: new Date().toISOString(),
      organization_id: organization.id,
      seat_count: 5,
      amount_usd: 50.0,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Update organization seat_count to match the purchase
    await db
      .update(organizations)
      .set({ seat_count: 5 })
      .where(sql`${organizations.id} = ${organization.id}`);

    const result = await getUserOrganizationsWithSeats(owner.id);

    expect(result).toHaveLength(1);
    expect(result[0].seatCount).toEqual({
      used: 3, // owner + 2 members
      total: 5,
    });
  });

  test('should handle case where used seats exceed total seats', async () => {
    const owner = await insertTestUser();
    const member1 = await insertTestUser();
    const member2 = await insertTestUser();
    const member3 = await insertTestUser();
    const organization = await createOrganization('Test Org', owner.id);

    // Add more members than seats
    await addUserToOrganization(organization.id, member1.id, 'member');
    await addUserToOrganization(organization.id, member2.id, 'member');
    await addUserToOrganization(organization.id, member3.id, 'member');

    // Create seat purchase with fewer seats than members
    await db.insert(organization_seats_purchases).values({
      subscription_stripe_id: 'sub_test123',
      starts_at: new Date().toISOString(),
      organization_id: organization.id,
      seat_count: 2,
      amount_usd: 20.0,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Update organization seat_count to match the purchase
    await db
      .update(organizations)
      .set({ seat_count: 2 })
      .where(sql`${organizations.id} = ${organization.id}`);

    const result = await getUserOrganizationsWithSeats(owner.id);

    expect(result).toHaveLength(1);
    expect(result[0].seatCount).toEqual({
      used: 4, // owner + 3 members
      total: 2, // Only 2 seats purchased
    });
  });

  test('should return multiple organizations with different seat counts', async () => {
    const user = await insertTestUser();
    const otherUser = await insertTestUser();

    // Create first organization with seats
    const org1 = await createOrganization('Organization 1', user.id);
    await db.insert(organization_seats_purchases).values({
      subscription_stripe_id: 'sub_org1_123',
      starts_at: new Date().toISOString(),
      organization_id: org1.id,
      seat_count: 3,
      amount_usd: 30.0,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Update organization seat_count to match the purchase
    await db
      .update(organizations)
      .set({ seat_count: 3 })
      .where(sql`${organizations.id} = ${org1.id}`);

    // Create second organization without seats
    const org2 = await createOrganization('Organization 2', otherUser.id);
    await addUserToOrganization(org2.id, user.id, 'member');

    // Create third organization with different seat count
    const org3 = await createOrganization('Organization 3', otherUser.id);
    await addUserToOrganization(org3.id, user.id, 'owner');
    await db.insert(organization_seats_purchases).values({
      subscription_stripe_id: 'sub_org3_123',
      organization_id: org3.id,
      starts_at: new Date().toISOString(),
      seat_count: 10,
      amount_usd: 100.0,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Update organization seat_count to match the purchase
    await db
      .update(organizations)
      .set({ seat_count: 10 })
      .where(sql`${organizations.id} = ${org3.id}`);

    const result = await getUserOrganizationsWithSeats(user.id);

    expect(result).toHaveLength(3);

    // Find each organization in results
    const org1Result = result.find(r => r.organizationId === org1.id);
    const org2Result = result.find(r => r.organizationId === org2.id);
    const org3Result = result.find(r => r.organizationId === org3.id);

    expect(org1Result).toBeDefined();
    expect(org1Result?.seatCount).toEqual({ used: 1, total: 3 });
    expect(org1Result?.role).toBe('owner');

    expect(org2Result).toBeDefined();
    expect(org2Result?.seatCount).toEqual({ used: 2, total: 0 }); // otherUser + user, no seats
    expect(org2Result?.role).toBe('member');

    expect(org3Result).toBeDefined();
    expect(org3Result?.seatCount).toEqual({ used: 2, total: 10 }); // otherUser + user
    expect(org3Result?.role).toBe('owner');
  });

  test('should not return organizations where user is not a member', async () => {
    const user1 = await insertTestUser();
    const user2 = await insertTestUser();

    // Create organization for user2 with seats
    const organization = await createOrganization('Other User Org', user2.id);
    await db.insert(organization_seats_purchases).values({
      starts_at: new Date().toISOString(),
      subscription_stripe_id: 'sub_test123',
      organization_id: organization.id,
      seat_count: 5,
      amount_usd: 50.0,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Update organization seat_count to match the purchase
    await db
      .update(organizations)
      .set({ seat_count: 5 })
      .where(sql`${organizations.id} = ${organization.id}`);

    const result = await getUserOrganizationsWithSeats(user1.id);

    expect(result).toEqual([]);
  });

  test('should include all required fields in response', async () => {
    const user = await insertTestUser();
    const orgName = 'Complete Test Org';
    const organization = await createOrganization(orgName, user.id);

    // Add some balance to the organization
    await db
      .update(organizations)
      .set({ microdollars_balance: 1000000, total_microdollars_acquired: 1000000 }) // $1.00 in microdollars
      .where(sql`${organizations.id} = ${organization.id}`);

    // Create seat purchase
    await db.insert(organization_seats_purchases).values({
      subscription_stripe_id: 'sub_test123',
      starts_at: new Date().toISOString(),
      organization_id: organization.id,
      seat_count: 7,
      amount_usd: 70.0,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Update organization seat_count to match the purchase
    await db
      .update(organizations)
      .set({ seat_count: 7 })
      .where(sql`${organizations.id} = ${organization.id}`);

    const result = await getUserOrganizationsWithSeats(user.id);

    expect(result).toHaveLength(1);
    const org = result[0];

    expect(org).toHaveProperty('organizationName', orgName);
    expect(org).toHaveProperty('organizationId', organization.id);
    expect(org).toHaveProperty('role', 'owner');
    expect(org).toHaveProperty('memberCount', 1);
    expect(org).toHaveProperty('balance', 1000000);
    expect(org).toHaveProperty('seatCount');
    expect(org.seatCount).toHaveProperty('used', 1);
    expect(org.seatCount).toHaveProperty('total', 7);
  });

  test('should handle organizations with zero seat purchases correctly', async () => {
    const user = await insertTestUser();
    const member = await insertTestUser();
    const organization = await createOrganization('Zero Seats Org', user.id);

    // Add a member but no seat purchases
    await addUserToOrganization(organization.id, member.id, 'member');

    const result = await getUserOrganizationsWithSeats(user.id);

    expect(result).toHaveLength(1);
    expect(result[0].seatCount).toEqual({
      used: 2, // owner + member
      total: 0, // no seat purchases
    });
  });

  test('should handle expired seat purchases by using most recent regardless of expiry', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    // Create expired seat purchase (most recent)
    await db.insert(organization_seats_purchases).values({
      subscription_stripe_id: 'sub_expired123',
      organization_id: organization.id,
      starts_at: new Date().toISOString(),
      seat_count: 8,
      amount_usd: 80.0,
      expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // Expired yesterday
    });

    // Update organization seat_count to match the purchase
    await db
      .update(organizations)
      .set({ seat_count: 8 })
      .where(sql`${organizations.id} = ${organization.id}`);

    const result = await getUserOrganizationsWithSeats(user.id);

    expect(result).toHaveLength(1);
    expect(result[0].seatCount).toEqual({
      used: 1,
      total: 8, // Should still use the most recent purchase even if expired
    });
  });

  test('should maintain consistent ordering across multiple calls', async () => {
    const user = await insertTestUser();
    const otherUser = await insertTestUser();

    // Create multiple organizations
    const org1 = await createOrganization('Org A', user.id);
    const org2 = await createOrganization('Org B', otherUser.id);
    const org3 = await createOrganization('Org C', otherUser.id);

    await addUserToOrganization(org2.id, user.id, 'member');
    await addUserToOrganization(org3.id, user.id, 'owner');

    // Add seat purchases
    await db.insert(organization_seats_purchases).values([
      {
        subscription_stripe_id: 'sub_a123',
        organization_id: org1.id,
        seat_count: 3,
        starts_at: new Date().toISOString(),
        amount_usd: 30.0,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        subscription_stripe_id: 'sub_c123',
        organization_id: org3.id,
        seat_count: 5,
        starts_at: new Date().toISOString(),
        amount_usd: 50.0,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ]);

    // Update organization seat_counts to match the purchases
    await db
      .update(organizations)
      .set({ seat_count: 3 })
      .where(sql`${organizations.id} = ${org1.id}`);

    await db
      .update(organizations)
      .set({ seat_count: 5 })
      .where(sql`${organizations.id} = ${org3.id}`);

    // Call multiple times to ensure consistent ordering
    const result1 = await getUserOrganizationsWithSeats(user.id);
    const result2 = await getUserOrganizationsWithSeats(user.id);

    expect(result1).toHaveLength(3);
    expect(result2).toHaveLength(3);

    // Results should be in the same order
    expect(result1.map(r => r.organizationId)).toEqual(result2.map(r => r.organizationId));
    expect(result1.map(r => r.seatCount)).toEqual(result2.map(r => r.seatCount));
  });

  test('should handle large numbers of members and seats', async () => {
    const owner = await insertTestUser();
    const organization = await createOrganization('Large Org', owner.id);

    // Add many members
    const members = [];
    for (let i = 0; i < 50; i++) {
      const member = await insertTestUser();
      await addUserToOrganization(organization.id, member.id, i % 3 === 0 ? 'owner' : 'member');
      members.push(member);
    }

    // Create large seat purchase
    await db.insert(organization_seats_purchases).values({
      subscription_stripe_id: 'sub_large123',
      starts_at: new Date().toISOString(),
      organization_id: organization.id,
      seat_count: 100,
      amount_usd: 1000.0,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Update organization seat_count to match the purchase
    await db
      .update(organizations)
      .set({ seat_count: 100 })
      .where(sql`${organizations.id} = ${organization.id}`);

    const result = await getUserOrganizationsWithSeats(owner.id);

    expect(result).toHaveLength(1);
    expect(result[0].seatCount).toEqual({
      used: 51, // owner + 50 members
      total: 100,
    });
    expect(result[0].memberCount).toBe(51);
  });

  test('should include pending invitations in member count', async () => {
    const owner = await insertTestUser();
    const organization = await createOrganization('Test Org', owner.id);

    // Create pending invitations
    await inviteUserToOrganization(organization.id, owner.id, 'invite1@example.com', 'member');
    await inviteUserToOrganization(organization.id, owner.id, 'invite2@example.com', 'owner');

    const result = await getUserOrganizationsWithSeats(owner.id);

    expect(result).toHaveLength(1);
    expect(result[0].memberCount).toBe(3); // owner + 2 pending invitations
    expect(result[0].seatCount).toEqual({
      used: 3, // owner + 2 pending invitations
      total: 0,
    });
  });

  test('should include both active members and pending invitations in count', async () => {
    const owner = await insertTestUser();
    const member = await insertTestUser();
    const organization = await createOrganization('Test Org', owner.id);

    // Add active member
    await addUserToOrganization(organization.id, member.id, 'member');

    // Create pending invitations
    await inviteUserToOrganization(organization.id, owner.id, 'invite1@example.com', 'member');
    await inviteUserToOrganization(organization.id, owner.id, 'invite2@example.com', 'owner');

    const result = await getUserOrganizationsWithSeats(owner.id);

    expect(result).toHaveLength(1);
    expect(result[0].memberCount).toBe(4); // owner + member + 2 pending invitations
    expect(result[0].seatCount).toEqual({
      used: 4, // owner + member + 2 pending invitations
      total: 0,
    });
  });

  test('should not include expired invitations in member count', async () => {
    const owner = await insertTestUser();
    const organization = await createOrganization('Test Org', owner.id);

    // Create valid invitation
    await inviteUserToOrganization(organization.id, owner.id, 'valid@example.com', 'member');

    // Create expired invitation by directly inserting into DB
    await db.insert(organization_invitations).values({
      organization_id: organization.id,
      email: 'expired@example.com',
      role: 'member',
      invited_by: owner.id,
      token: 'expired-token',
      expires_at: sql`NOW() - INTERVAL '1 day'`, // Expired yesterday
    });

    const result = await getUserOrganizationsWithSeats(owner.id);

    expect(result).toHaveLength(1);
    expect(result[0].memberCount).toBe(2); // owner + 1 valid invitation (not expired)
    expect(result[0].seatCount).toEqual({
      used: 2,
      total: 0,
    });
  });

  test('should not include accepted invitations in member count', async () => {
    const owner = await insertTestUser();
    const organization = await createOrganization('Test Org', owner.id);

    // Create pending invitation
    await inviteUserToOrganization(organization.id, owner.id, 'pending@example.com', 'member');

    // Create accepted invitation by directly inserting into DB
    await db.insert(organization_invitations).values({
      organization_id: organization.id,
      email: 'accepted@example.com',
      role: 'member',
      invited_by: owner.id,
      token: 'accepted-token',
      expires_at: sql`NOW() + INTERVAL '7 days'`,
      accepted_at: sql`NOW()`, // Already accepted
    });

    const result = await getUserOrganizationsWithSeats(owner.id);

    expect(result).toHaveLength(1);
    expect(result[0].memberCount).toBe(2); // owner + 1 pending invitation (not accepted)
    expect(result[0].seatCount).toEqual({
      used: 2,
      total: 0,
    });
  });

  test('should handle organizations with seats and pending invitations', async () => {
    const owner = await insertTestUser();
    const member = await insertTestUser();
    const organization = await createOrganization('Test Org', owner.id);

    // Add active member
    await addUserToOrganization(organization.id, member.id, 'owner');

    // Create seat purchase
    await db.insert(organization_seats_purchases).values({
      subscription_stripe_id: 'sub_test123',
      starts_at: new Date().toISOString(),
      organization_id: organization.id,
      seat_count: 5,
      amount_usd: 50.0,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Update organization seat_count to match the purchase
    await db
      .update(organizations)
      .set({ seat_count: 5 })
      .where(sql`${organizations.id} = ${organization.id}`);

    // Create pending invitations
    await inviteUserToOrganization(organization.id, owner.id, 'invite1@example.com', 'member');
    await inviteUserToOrganization(organization.id, owner.id, 'invite2@example.com', 'member');

    const result = await getUserOrganizationsWithSeats(owner.id);

    expect(result).toHaveLength(1);
    expect(result[0].memberCount).toBe(4); // owner + member + 2 pending invitations
    expect(result[0].seatCount).toEqual({
      used: 4, // owner + member + 2 pending invitations
      total: 5,
    });
  });

  test('should handle case where used seats (including invitations) exceed total seats', async () => {
    const owner = await insertTestUser();
    const member1 = await insertTestUser();
    const member2 = await insertTestUser();
    const organization = await createOrganization('Test Org', owner.id);

    // Add active members
    await addUserToOrganization(organization.id, member1.id, 'member');
    await addUserToOrganization(organization.id, member2.id, 'member');

    // Create seat purchase with fewer seats than total members + invitations
    await db.insert(organization_seats_purchases).values({
      subscription_stripe_id: 'sub_test123',
      starts_at: new Date().toISOString(),
      organization_id: organization.id,
      seat_count: 2,
      amount_usd: 20.0,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Update organization seat_count to match the purchase
    await db
      .update(organizations)
      .set({ seat_count: 2 })
      .where(sql`${organizations.id} = ${organization.id}`);

    // Create pending invitations that will exceed seat count
    await inviteUserToOrganization(organization.id, owner.id, 'invite1@example.com', 'member');
    await inviteUserToOrganization(organization.id, owner.id, 'invite2@example.com', 'member');

    const result = await getUserOrganizationsWithSeats(owner.id);

    expect(result).toHaveLength(1);
    expect(result[0].memberCount).toBe(5); // owner + 2 members + 2 pending invitations
    expect(result[0].seatCount).toEqual({
      used: 5, // Total members + invitations
      total: 2, // Only 2 seats purchased
    });
  });

  test('should handle multiple organizations with different invitation counts', async () => {
    const user = await insertTestUser();
    const otherUser = await insertTestUser();

    // Create first organization with invitations
    const org1 = await createOrganization('Organization 1', user.id);
    await inviteUserToOrganization(org1.id, user.id, 'invite1@example.com', 'member');

    // Create second organization without invitations
    const org2 = await createOrganization('Organization 2', otherUser.id);
    await addUserToOrganization(org2.id, user.id, 'member');

    // Create third organization with multiple invitations
    const org3 = await createOrganization('Organization 3', otherUser.id);
    await addUserToOrganization(org3.id, user.id, 'owner');
    await inviteUserToOrganization(org3.id, otherUser.id, 'invite2@example.com', 'member');
    await inviteUserToOrganization(org3.id, otherUser.id, 'invite3@example.com', 'owner');

    const result = await getUserOrganizationsWithSeats(user.id);

    expect(result).toHaveLength(3);

    // Find each organization in results
    const org1Result = result.find(r => r.organizationId === org1.id);
    const org2Result = result.find(r => r.organizationId === org2.id);
    const org3Result = result.find(r => r.organizationId === org3.id);

    expect(org1Result).toBeDefined();
    expect(org1Result?.memberCount).toBe(2); // user + 1 invitation
    expect(org1Result?.seatCount).toEqual({ used: 2, total: 0 });

    expect(org2Result).toBeDefined();
    expect(org2Result?.memberCount).toBe(2); // otherUser + user, no invitations
    expect(org2Result?.seatCount).toEqual({ used: 2, total: 0 });

    expect(org3Result).toBeDefined();
    expect(org3Result?.memberCount).toBe(4); // otherUser + user + 2 invitations
    expect(org3Result?.seatCount).toEqual({ used: 4, total: 0 });
  });
});

describe('getMostRecentSeatPurchase', () => {
  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
  });

  test('should return null when organization has no purchases', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    const result = await getMostRecentSeatPurchase(organization.id);

    expect(result).toBeNull();
  });

  test('should return the most recent purchase when multiple purchases exist', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    // Create multiple purchases
    await db.insert(organization_seats_purchases).values([
      {
        subscription_stripe_id: 'sub_old123',
        organization_id: organization.id,
        seat_count: 3,
        amount_usd: 30.0,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        created_at: sql`NOW() - INTERVAL '2 days'`,
        starts_at: new Date().toISOString(),
      },
      {
        subscription_stripe_id: 'sub_middle123',
        organization_id: organization.id,
        seat_count: 5,
        amount_usd: 50.0,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        created_at: sql`NOW() - INTERVAL '1 day'`,
        starts_at: new Date().toISOString(),
      },
      {
        subscription_stripe_id: 'sub_new123',
        organization_id: organization.id,
        seat_count: 10,
        amount_usd: 100.0,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        starts_at: new Date().toISOString(),
      },
    ]);

    const result = await getMostRecentSeatPurchase(organization.id);

    expect(result).not.toBeNull();
    expect(result?.seat_count).toBe(10); // Should return the most recent purchase
    expect(result?.subscription_stripe_id).toBe('sub_new123');
  });

  test('should return single purchase when only one exists', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    // Create single purchase
    await db.insert(organization_seats_purchases).values({
      subscription_stripe_id: 'sub_single123',
      organization_id: organization.id,
      seat_count: 7,
      amount_usd: 70.0,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      starts_at: new Date().toISOString(),
    });

    const result = await getMostRecentSeatPurchase(organization.id);

    expect(result).not.toBeNull();
    expect(result?.seat_count).toBe(7);
    expect(result?.subscription_stripe_id).toBe('sub_single123');
  });

  test('should only return purchase for the specified organization', async () => {
    const user = await insertTestUser();
    const org1 = await createOrganization('Test Org 1', user.id);
    const org2 = await createOrganization('Test Org 2', user.id);

    // Create purchases for both organizations
    await db.insert(organization_seats_purchases).values([
      {
        subscription_stripe_id: 'sub_org1_123',
        organization_id: org1.id,
        seat_count: 5,
        amount_usd: 50.0,
        starts_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        subscription_stripe_id: 'sub_org2_123',
        organization_id: org2.id,
        seat_count: 10,
        amount_usd: 100.0,
        starts_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ]);

    const result = await getMostRecentSeatPurchase(org1.id);

    expect(result).not.toBeNull();
    expect(result?.organization_id).toBe(org1.id);
    expect(result?.seat_count).toBe(5);
  });
});

describe('getOrganizationSeatUsage', () => {
  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
  });

  test('should not count billing_manager role in seat usage', async () => {
    const owner = await insertTestUser();
    const member = await insertTestUser();
    const billingManager = await insertTestUser();
    const organization = await createOrganization('Test Org', owner.id);

    // Add a regular member
    await addUserToOrganization(organization.id, member.id, 'member');

    // Add a billing_manager - should NOT count towards seats
    await addUserToOrganization(organization.id, billingManager.id, 'billing_manager');

    // Update organization seat_count
    await db
      .update(organizations)
      .set({ seat_count: 5 })
      .where(sql`${organizations.id} = ${organization.id}`);

    const result = await getOrganizationSeatUsage(organization.id);

    // Should only count owner + member (2), not billing_manager
    expect(result).toEqual({
      used: 2,
      total: 5,
    });
  });

  test('should count all non-billing_manager roles in seat usage', async () => {
    const owner = await insertTestUser();
    const member = await insertTestUser();
    const admin = await insertTestUser();
    const billingManager1 = await insertTestUser();
    const billingManager2 = await insertTestUser();
    const organization = await createOrganization('Test Org', owner.id);

    // Add various roles
    await addUserToOrganization(organization.id, member.id, 'member');
    await addUserToOrganization(organization.id, admin.id, 'owner');
    await addUserToOrganization(organization.id, billingManager1.id, 'billing_manager');
    await addUserToOrganization(organization.id, billingManager2.id, 'billing_manager');

    // Update organization seat_count
    await db
      .update(organizations)
      .set({ seat_count: 10 })
      .where(sql`${organizations.id} = ${organization.id}`);

    const result = await getOrganizationSeatUsage(organization.id);

    // Should count owner + member + admin (3), not billing_managers
    expect(result).toEqual({
      used: 3,
      total: 10,
    });
  });
});

describe('getUserOrganizationsWithSeats billing_manager exclusion', () => {
  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
  });

  test('should not count billing_manager members in seat count', async () => {
    const owner = await insertTestUser();
    const member = await insertTestUser();
    const billingManager = await insertTestUser();
    const organization = await createOrganization('Test Org', owner.id);

    // Add a regular member
    await addUserToOrganization(organization.id, member.id, 'member');

    // Add a billing_manager - should NOT count towards seats
    await addUserToOrganization(organization.id, billingManager.id, 'billing_manager');

    // Update organization seat_count
    await db
      .update(organizations)
      .set({ seat_count: 5 })
      .where(sql`${organizations.id} = ${organization.id}`);

    const result = await getUserOrganizationsWithSeats(owner.id);

    expect(result).toHaveLength(1);
    // Should only count owner + member (2), not billing_manager
    expect(result[0].seatCount).toEqual({
      used: 2,
      total: 5,
    });
    expect(result[0].memberCount).toBe(2);
  });

  test('should not count billing_manager invitations in seat count', async () => {
    const owner = await insertTestUser();
    const organization = await createOrganization('Test Org', owner.id);

    // Create a regular member invitation
    await inviteUserToOrganization(organization.id, owner.id, 'member@example.com', 'member');

    // Create a billing_manager invitation - should NOT count towards seats
    await inviteUserToOrganization(
      organization.id,
      owner.id,
      'billing@example.com',
      'billing_manager'
    );

    // Update organization seat_count
    await db
      .update(organizations)
      .set({ seat_count: 5 })
      .where(sql`${organizations.id} = ${organization.id}`);

    const result = await getUserOrganizationsWithSeats(owner.id);

    expect(result).toHaveLength(1);
    // Should only count owner + member invitation (2), not billing_manager invitation
    expect(result[0].seatCount).toEqual({
      used: 2,
      total: 5,
    });
    expect(result[0].memberCount).toBe(2);
  });
});
