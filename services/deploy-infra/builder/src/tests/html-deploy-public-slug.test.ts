import { allocateFriendlySlug } from '../html-deploy/public-slug';

describe('HTML deployment public slug allocation', () => {
  it('retries reserved and concurrently claimed friendly slugs', async () => {
    const generated = ['old-direct-0001', 'taken-mapping-0002', 'open-meadow-0003'];
    const mapped: string[] = [];

    const slug = await allocateFriendlySlug({
      generate: () => generated.shift() ?? 'unexpected',
      isStored: async candidate => candidate === 'old-direct-0001',
      map: async candidate => {
        mapped.push(candidate);
        return candidate === 'open-meadow-0003';
      },
    });

    expect(slug).toBe('open-meadow-0003');
    expect(mapped).toEqual(['taken-mapping-0002', 'open-meadow-0003']);
  });

  it('fails without assigning a colliding slug', async () => {
    await expect(
      allocateFriendlySlug({
        generate: () => 'taken-slug-0001',
        isStored: async () => false,
        map: async () => false,
      })
    ).rejects.toThrow('Unable to allocate an available deployment URL');
  });
});
