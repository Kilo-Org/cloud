import { isPrivateQuickDeploymentWorkerName, setSlugMappingRequestSchema } from './schemas';

describe('private quick deployment worker names', () => {
  it('reserves the internal quick-deploy namespace', () => {
    expect(isPrivateQuickDeploymentWorkerName('qdpl-12345678-1234-1234-1234-123456789abc')).toBe(
      true
    );
    expect(isPrivateQuickDeploymentWorkerName('qdpl-next-format')).toBe(true);
  });

  it('does not reserve public worker names or similar prefixes', () => {
    expect(isPrivateQuickDeploymentWorkerName('bright-fern-4821')).toBe(false);
    expect(isPrivateQuickDeploymentWorkerName('dpl-12345678-1234-1234-1234-123456789abc')).toBe(
      false
    );
    expect(isPrivateQuickDeploymentWorkerName('qdpl')).toBe(false);
  });
});

describe('slug mapping request schema', () => {
  it.each(['www', 'dpl-private', 'qdpl-private', 'bright--fern-4821'])(
    'rejects public slug %s using the shared deployment slug contract',
    slug => {
      expect(setSlugMappingRequestSchema.safeParse({ slug }).success).toBe(false);
    }
  );

  it('accepts a public deployment slug', () => {
    expect(setSlugMappingRequestSchema.safeParse({ slug: 'bright-fern-4821' }).success).toBe(true);
  });
});
