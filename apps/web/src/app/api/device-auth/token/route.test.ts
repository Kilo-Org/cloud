import { NextRequest } from 'next/server';

jest.mock('@/lib/device-auth/device-auth');

import { consumeDeviceAuthByDeviceCode } from '@/lib/device-auth/device-auth';
import { POST } from './route';

const mockConsume = jest.mocked(consumeDeviceAuthByDeviceCode);

describe('POST /api/device-auth/token', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createRequest = (body: unknown) =>
    new NextRequest('http://localhost:3000/api/device-auth/token', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });

  test('returns 200 with token on approved', async () => {
    mockConsume.mockResolvedValue({
      status: 'approved',
      token: 'jwt-token',
      userId: 'user-1',
      userEmail: 'user@example.com',
    });

    const response = await POST(createRequest({ deviceCode: 'secret123' }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      status: 'approved',
      token: 'jwt-token',
      userId: 'user-1',
      userEmail: 'user@example.com',
    });
    expect(mockConsume).toHaveBeenCalledWith('secret123', { supportsRefresh: undefined });
  });

  test('passes supportsRefresh through to consume', async () => {
    mockConsume.mockResolvedValue({
      status: 'approved',
      token: 'jwt-token',
      userId: 'user-1',
      userEmail: 'user@example.com',
    });

    await POST(createRequest({ deviceCode: 'secret123', supportsRefresh: true }));
    expect(mockConsume).toHaveBeenCalledWith('secret123', { supportsRefresh: true });
  });

  test('returns refreshToken and expiresIn when consumer returns short pair', async () => {
    mockConsume.mockResolvedValue({
      status: 'approved',
      token: 'short-jwt',
      refreshToken: 'refresh-abc',
      expiresIn: 3600,
      userId: 'user-1',
      userEmail: 'user@example.com',
    });

    const response = await POST(createRequest({ deviceCode: 'secret123', supportsRefresh: true }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      status: 'approved',
      token: 'short-jwt',
      refreshToken: 'refresh-abc',
      expiresIn: 3600,
      userId: 'user-1',
      userEmail: 'user@example.com',
    });
  });

  test('returns 202 on pending', async () => {
    mockConsume.mockResolvedValue({ status: 'pending' });

    const response = await POST(createRequest({ deviceCode: 'secret123' }));
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data).toEqual({ status: 'pending' });
  });

  test('returns 403 on denied', async () => {
    mockConsume.mockResolvedValue({ status: 'denied' });

    const response = await POST(createRequest({ deviceCode: 'secret123' }));
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data).toEqual({ status: 'denied' });
  });

  test('returns 410 on expired', async () => {
    mockConsume.mockResolvedValue({ status: 'expired' });

    const response = await POST(createRequest({ deviceCode: 'secret123' }));
    const data = await response.json();

    expect(response.status).toBe(410);
    expect(data).toEqual({ status: 'expired' });
  });

  test('returns 410 on consumed', async () => {
    mockConsume.mockResolvedValue({ status: 'consumed' });

    const response = await POST(createRequest({ deviceCode: 'secret123' }));
    const data = await response.json();

    expect(response.status).toBe(410);
    expect(data).toEqual({ status: 'expired' });
  });

  test('returns 410 when user_code (display code) is used instead of device secret', async () => {
    mockConsume.mockResolvedValue({ status: 'expired' });

    const response = await POST(createRequest({ deviceCode: 'ABCD-EFGH' }));
    const data = await response.json();

    expect(response.status).toBe(410);
    expect(data).toEqual({ status: 'expired' });
    expect(mockConsume).toHaveBeenCalledWith('ABCD-EFGH', { supportsRefresh: undefined });
  });

  test('returns 400 for missing deviceCode', async () => {
    const response = await POST(createRequest({}));
    expect(response.status).toBe(400);
  });

  test('returns 400 for invalid JSON', async () => {
    const req = new NextRequest('http://localhost:3000/api/device-auth/token', {
      method: 'POST',
      body: '{',
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(req);
    expect(response.status).toBe(400);
  });
});
