import { POST } from './route';

describe('Apple IAP notification route', () => {
  it('rejects missing signedPayload', async () => {
    const response = await POST(
      new Request('https://kilo.test/api/apple/iap/notifications', {
        method: 'POST',
        body: JSON.stringify({}),
      })
    );

    await expect(response.text()).resolves.toBe('Missing signedPayload');
    expect(response.status).toBe(400);
  });
});
