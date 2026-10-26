jest.mock('@/lib/bounded-service-fetch', () => ({
  fetchWithinBudget: jest.fn(async () => new Response(null, { status: 204 })),
}));
jest.mock('@kilocode/web-shared/lib/dotenvx', () => ({
  getEnvVariable: (name: string) =>
    name === 'NEXT_PUBLIC_EVENT_SERVICE_URL' ? 'wss://events.example.test/' : undefined,
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'internal-secret',
  SESSION_INGEST_WORKER_URL: 'https://ingest.example.test/',
}));

import { fetchWithinBudget } from '@/lib/bounded-service-fetch';
import { closeDeviceSessionRealtimeConnections } from './device-session-realtime';

const fetchMock = jest.mocked(fetchWithinBudget);

describe('closeDeviceSessionRealtimeConnections', () => {
  beforeEach(() => {
    fetchMock.mockClear();
  });

  it('calls both realtime owners over HTTP, including the WebSocket event-service base', async () => {
    await closeDeviceSessionRealtimeConnections({
      kiloUserId: 'usr_1',
      deviceSessionId: '11111111-1111-4111-8111-111111111111',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ingest.example.test/internal/device-session/revoke',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://events.example.test/internal/device-session/revoke',
      expect.objectContaining({ method: 'POST' })
    );
  });
});
