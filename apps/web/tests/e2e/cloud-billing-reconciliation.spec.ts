import { expect, test } from '@chromatic-com/playwright';
import { createDrizzleClient } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { randomUUID } from 'node:crypto';
import { hosted_domain_specials } from '@/lib/auth/constants';

async function seedAdmin() {
  const uniqueId = randomUUID().slice(0, 8);
  const email = `billing-reconciliation-${uniqueId}+stytchpass@example.com`;
  const postgresUrl = process.env.POSTGRES_URL;
  if (!postgresUrl) throw new Error('POSTGRES_URL must be set for reconciliation tests');
  const { db, pool } = createDrizzleClient({
    connectionString: postgresUrl,
    poolConfig: { max: 1 },
  });
  try {
    await db.insert(kilocode_users).values({
      id: `billing-reconciliation-${uniqueId}`,
      google_user_email: email,
      google_user_name: `billing-reconciliation-${uniqueId}`,
      google_user_image_url: '',
      hosted_domain: hosted_domain_specials.fake_devonly,
      stripe_customer_id: `cus_billing_reconciliation_${uniqueId}`,
      completed_welcome_form: true,
      customer_source: 'Billing reconciliation test',
      has_validation_stytch: true,
      is_admin: true,
    });
  } finally {
    await pool.end();
  }
  return email;
}

test.describe('Cloud Billing reconciliation', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.setTimeout(60_000);

  test('runs only on click with the applied request and reuses the raw response', async ({
    page,
  }) => {
    const email = await seedAdmin();
    await page.goto(
      `/users/sign_in?fakeUser=${encodeURIComponent(email)}&callbackPath=${encodeURIComponent('/admin/cloud-billing-skus?tab=usage-records')}`,
      { waitUntil: 'domcontentloaded' }
    );
    await page.waitForURL(url => url.pathname !== '/users/sign_in', {
      timeout: 30_000,
      waitUntil: 'domcontentloaded',
    });
    if (new URL(page.url()).pathname === '/account-verification') {
      await expect(page.getByText('Creating your account')).toBeHidden({ timeout: 30_000 });
    }
    if (new URL(page.url()).pathname !== '/admin/cloud-billing-skus') {
      await page.goto('/admin/cloud-billing-skus?tab=usage-records', {
        waitUntil: 'domcontentloaded',
      });
    }

    const reconcileButton = page.getByRole('button', { name: /Reconcil/ });
    await expect(reconcileButton).toHaveCount(0);

    const appliedSubjectId = `applied-${randomUUID()}`;
    await page.getByLabel('Exact value').fill(appliedSubjectId);
    await page.getByLabel('Window start').fill('2026-07-28T10:00');
    await page.getByLabel('Window end').fill('2026-07-28T12:00');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(reconcileButton).toBeVisible();

    let providerRequests = 0;
    let providerRequestBody = '';
    const providerResponse = Promise.withResolvers<void>();
    await page.route(
      '**/api/trpc/admin.cloudBillingSkus.reconcileUsageWithCloudflare?batch=1',
      async route => {
        providerRequests += 1;
        providerRequestBody = route.request().postData() ?? '';
        await providerResponse.promise;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              result: {
                data: {
                  subjectType: 'user',
                  subjectId: appliedSubjectId,
                  start: '2026-07-28T15:00:00.000Z',
                  end: '2026-07-28T17:00:00.000Z',
                  generatedAt: '2026-07-29T17:00:00.000Z',
                  comparison: {
                    available: true,
                    method: 'allocated_memory_byte_seconds',
                    description:
                      'Provider awake seconds use allocated memory byte-seconds divided by the provisioned memory for the recorded service class. Difference is provider minus meter.',
                  },
                  totals: {
                    meterAcceptedSeconds: 299,
                    providerComparisonSeconds: 301.2,
                    differenceSeconds: 2.2,
                    differencePercent: 0.7358,
                    providerCpuTimeSec: 18.42,
                    intervalCount: 1,
                    uniqueMeterInstances: 1,
                    queriedCloudflareInstances: 1,
                  },
                  counts: {
                    matched: 1,
                    missing: 0,
                    ambiguous: 0,
                    partial: 0,
                    comparisonUnavailable: 0,
                  },
                  provider: {
                    requested: true,
                    partial: false,
                    issues: [],
                    rawResponses: [
                      {
                        dataset: 'containersUsageAdaptiveGroups',
                        windowIndex: 0,
                        batchIndex: 0,
                        window: {
                          start: '2026-07-28T15:00:00.000Z',
                          end: '2026-07-28T17:00:00.000Z',
                        },
                        body: {
                          data: {
                            viewer: {
                              accounts: [
                                {
                                  containersUsageAdaptiveGroups: [
                                    {
                                      dimensions: {
                                        applicationId: 'app-cloud-agent-next',
                                        instanceId: 'provider-instance',
                                      },
                                      sum: {
                                        cpuTimeSec: 18.42,
                                        allocatedMemory: 1_940_467_920_076.8,
                                        allocatedDisk: 3_012_000_000_000,
                                        txBytes: 20_480,
                                      },
                                    },
                                  ],
                                },
                              ],
                            },
                          },
                          errors: null,
                        },
                      },
                    ],
                  },
                  rows: [
                    {
                      instanceId: 'provider-instance',
                      providerInstanceId: 'provider-instance',
                      meterInstanceIds: ['meter-instance'],
                      services: ['cloud-agent-next-sandbox-small-containment'],
                      providerApplicationIds: ['app-cloud-agent-next'],
                      skuIds: ['cloud-agent-small-2026-07'],
                      intervalCount: 1,
                      meterAcceptedSeconds: 299,
                      providerComparisonSeconds: 301.2,
                      providerMemorySeconds: 301.2,
                      providerDiskSeconds: 301.2,
                      provisionedMemoryBytes: 6_442_450_944,
                      provisionedDiskBytes: 10_000_000_000,
                      differenceSeconds: 2.2,
                      differencePercent: 0.7358,
                      providerCpuTimeSec: 18.42,
                      providerAllocatedMemoryByteSeconds: 1_940_467_920_076.8,
                      providerAllocatedDiskByteSeconds: 3_012_000_000_000,
                      providerTxBytes: 20_480,
                      status: 'matched',
                      statusDetail: 'Provider capacity inputs agree.',
                    },
                  ],
                },
              },
            },
          ]),
        });
      }
    );

    expect(providerRequests).toBe(0);
    await page.getByLabel('Exact value').fill('edited-draft-subject');
    await reconcileButton.click();
    await expect(reconcileButton).toBeDisabled();
    providerResponse.resolve();
    await expect(page.getByText('1 matched')).toBeVisible();
    expect(providerRequests).toBe(1);
    expect(providerRequestBody).toContain(appliedSubjectId);
    expect(providerRequestBody).not.toContain('edited-draft-subject');

    await page.getByRole('button', { name: 'View raw Cloudflare response' }).click();
    await expect(page.getByText(/containersUsageAdaptiveGroups · window 1/)).toBeVisible();
    await expect(page.locator('pre')).toContainText('provider-instance');
    expect(providerRequests).toBe(1);

    await page.getByRole('button', { name: 'Reset' }).click();
    await expect(reconcileButton).toHaveCount(0);
    await expect(page.getByText('1 matched')).toHaveCount(0);
  });
});
