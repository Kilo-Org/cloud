const ATTACHMENTS_BUCKET_ENV = 'CLOUD_AGENT_R2_ATTACHMENTS_BUCKET_NAME';

// The module validates its configuration on import, so each case needs a fresh
// module registry; a static import would freeze the first evaluation's result.
describe('r2 client bucket configuration', () => {
  const originalValue = process.env[ATTACHMENTS_BUCKET_ENV];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ATTACHMENTS_BUCKET_ENV];
    } else {
      process.env[ATTACHMENTS_BUCKET_ENV] = originalValue;
    }
    jest.resetModules();
  });

  test('refuses to load without the cloud-agent attachments bucket', async () => {
    delete process.env[ATTACHMENTS_BUCKET_ENV];

    await expect(
      jest.isolateModulesAsync(async () => {
        await import('@kilocode/web-shared/lib/r2/client');
      })
    ).rejects.toThrow(ATTACHMENTS_BUCKET_ENV);
  });

  test('exports the configured cloud-agent attachments bucket', async () => {
    const bucket = 'test-cloud-agent-attachments';
    process.env[ATTACHMENTS_BUCKET_ENV] = bucket;

    await jest.isolateModulesAsync(async () => {
      const { r2CloudAgentAttachmentsBucketName } =
        await import('@kilocode/web-shared/lib/r2/client');
      expect(r2CloudAgentAttachmentsBucketName).toBe(bucket);
    });
  });
});
