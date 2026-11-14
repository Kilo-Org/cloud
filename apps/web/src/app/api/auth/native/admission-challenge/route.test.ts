jest.mock('@/lib/auth/native-admission', () => ({
  issueAdmissionChallenge: jest.fn(),
  ChallengeRateLimitError: class ChallengeRateLimitError extends Error {},
}));

import { issueAdmissionChallenge } from '@/lib/auth/native-admission';
import { POST } from './route';

const mockIssueAdmissionChallenge = jest.mocked(issueAdmissionChallenge);

function createRequest(headers: Record<string, string>): Request {
  return new Request('http://localhost:3000/api/auth/native/admission-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ platform: 'ios' }),
  });
}

describe('POST /api/auth/native/admission-challenge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIssueAdmissionChallenge.mockResolvedValue({ challenge: 'challenge-1', expiresIn: 120 });
  });

  it('issues the challenge for the platform-observed address', async () => {
    const response = await POST(
      createRequest({
        'x-vercel-forwarded-for': '203.0.113.7, 70.41.3.18',
        'x-forwarded-for': '192.0.2.11, 10.0.0.1',
        'x-real-ip': '198.51.100.4',
      })
    );

    expect(response.status).toBe(200);
    expect(mockIssueAdmissionChallenge).toHaveBeenCalledWith(expect.anything(), '203.0.113.7');
  });

  it('keeps one challenge bucket for one platform address', async () => {
    await POST(createRequest({ 'x-vercel-forwarded-for': '203.0.113.7' }));
    await POST(
      createRequest({
        'x-vercel-forwarded-for': '203.0.113.7',
        'x-forwarded-for': '192.0.2.44, 10.0.0.1',
        'x-real-ip': '198.51.100.4',
      })
    );

    const addresses = mockIssueAdmissionChallenge.mock.calls.map(call => call[1]);
    expect(addresses).toEqual(['203.0.113.7', '203.0.113.7']);
  });
});
