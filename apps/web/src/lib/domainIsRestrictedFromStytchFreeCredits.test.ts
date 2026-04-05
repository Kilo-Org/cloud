import { describe, test, expect } from '@jest/globals';
import { domainIsRestrictedFromStytchFreeCredits } from './domainIsRestrictedFromStytchFreeCredits';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { hosted_domain_specials } from '@/lib/auth/constants';

describe('domainIsRestrictedFromStytchFreeCredits', () => {
  test('should return false for personal domain (@@personal@@)', async () => {
    const user = await insertTestUser({
      google_user_email: `test-${Math.random()}@example.com`,
      hosted_domain: hosted_domain_specials.non_workspace_google_account,
    });

    const result = await domainIsRestrictedFromStytchFreeCredits(user);
    expect(result).toBe(false);
  });

  test('should return false for github (@@github@@)', async () => {
    const user = await insertTestUser({
      google_user_email: `test-${Math.random()}@example.com`,
      hosted_domain: hosted_domain_specials.github,
    });

    const result = await domainIsRestrictedFromStytchFreeCredits(user);
    expect(result).toBe(false);
  });

  test('should return false when domain has 5 or fewer users', async () => {
    const domain = `smallcompany-${Math.random()}.co.uk`; //might as well check nested TLDs

    // Create 4 users with the same domain
    for (let i = 0; i < 4; i++) {
      await insertTestUser({
        google_user_email: `user${i}-${Math.random()}@${domain}`,
        hosted_domain: domain,
      });
    }

    const testUser = await insertTestUser({
      google_user_email: `testuser-${Math.random()}@${domain}`,
      hosted_domain: domain,
    });

    const result = await domainIsRestrictedFromStytchFreeCredits(testUser);
    expect(result).toBe(false); // 5 total users (4 + 1) should not be restricted
  });

  test('should return true when domain has more than 5 users', async () => {
    const domain = `bigcompany-${Math.random()}.com`;

    // Create 5 users with the same domain
    for (let i = 0; i < 5; i++) {
      await insertTestUser({
        google_user_email: `user${i}-${Math.random()}@${domain}`,
        hosted_domain: domain,
      });
    }

    const testUser = await insertTestUser({
      google_user_email: `testuser-${Math.random()}@${domain}`,
      hosted_domain: domain,
    });

    const result = await domainIsRestrictedFromStytchFreeCredits(testUser);
    expect(result).toBe(true); // 6 total users (5 + 1) should be restricted
  });

  test('should actually handle domains and not postfixes', async () => {
    const domain = `example.com`;
    const otherDomain = `anotherexample.com`;
    // Create 5 users with the same domain
    for (let i = 0; i < 5; i++) {
      await insertTestUser({
        google_user_email: `user${i}-${Math.random()}@${domain}`,
        hosted_domain: domain,
      });
    }

    const testUser = await insertTestUser({
      google_user_email: `testuser-${Math.random()}@${otherDomain}`,
      hosted_domain: otherDomain,
    });
    const result = await domainIsRestrictedFromStytchFreeCredits(testUser);
    expect(result).toBe(false);
  });

  test('should only count users from the same domain', async () => {
    const domain1 = `company1-${Math.random()}.com`;
    const domain2 = `company2-${Math.random()}.com`;

    // Create 10 users for domain1
    for (let i = 0; i < 10; i++) {
      await insertTestUser({
        google_user_email: `user${i}-${Math.random()}@${domain1}`,
        hosted_domain: domain1,
      });
    }

    // Create only 3 users for domain2
    for (let i = 0; i < 3; i++) {
      await insertTestUser({
        google_user_email: `user${i}-${Math.random()}@${domain2}`,
        hosted_domain: domain2,
      });
    }

    const testUser = await insertTestUser({
      google_user_email: `testuser-${Math.random()}@${domain2}`,
      hosted_domain: domain2,
    });

    const result = await domainIsRestrictedFromStytchFreeCredits(testUser);
    expect(result).toBe(false); // Should be false because domain2 only has 4 users total
  });

  test('should handle empty database correctly', async () => {
    const user = await insertTestUser({
      google_user_email: `lonely-${Math.random()}@newdomain.com`,
      hosted_domain: `newdomain-${Math.random()}.com`,
    });

    const result = await domainIsRestrictedFromStytchFreeCredits(user);
    expect(result).toBe(false); // Only 1 user in the domain
  });
});
