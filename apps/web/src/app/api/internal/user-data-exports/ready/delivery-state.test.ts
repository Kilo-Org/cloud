import { markDelivery, markRetryableDelivery } from './delivery-state';

describe('export-ready email delivery leases', () => {
  it('reports a lost lease when terminal delivery updates no row', async () => {
    const execute = jest.fn().mockResolvedValue({ rows: [] });

    await expect(
      markDelivery(execute, crypto.randomUUID(), crypto.randomUUID(), 'sent')
    ).resolves.toBe(false);
  });

  it('reports a held lease when retryable delivery updates the claimed row', async () => {
    const execute = jest.fn().mockResolvedValue({ rows: [{ id: crypto.randomUUID() }] });

    await expect(
      markRetryableDelivery(execute, crypto.randomUUID(), crypto.randomUUID())
    ).resolves.toBe(true);
  });
});
