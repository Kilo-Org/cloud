import { expect, it, vi } from 'vitest';
import { createEc2TestAccess } from './ec2-test-access.js';

const origin = 'https://test.example.com';
const config = { origin, clientId: 'fixture.access', clientSecret: 'fixture_secret' };

it('binds test Access proof to the launch origin and host callback methods', async () => {
  expect(() => createEc2TestAccess(config, 'https://other.example.com')).toThrow('origin mismatch');
  const access = createEc2TestAccess(config, origin);
  const send = vi.fn(async (request: Request) => {
    expect(request.redirect).toBe('manual');
    expect(request.headers.get('cf-access-client-id')).toBe(config.clientId);
    expect(request.headers.get('cf-access-client-secret')).toBe(config.clientSecret);
    expect(request.headers.get('x-kilo-egress-credential')).toBe('fixture_grant');
    expect(await request.text()).toBe('audit row');
    return new Response(null, {
      status: 302,
      headers: {
        location: 'https://other.example.com',
        'set-cookie': 'CF_Authorization=fixture_assertion',
      },
    });
  });
  const request = (url: string) =>
    new Request(url, {
      method: 'POST',
      body: 'audit row',
      headers: { 'x-kilo-egress-credential': 'fixture_grant' },
    });
  for (const target of [
    'https://other.example.com/aws-egress/sbx_1/audit',
    'https://test.example.com:444/aws-egress/sbx_1/audit',
    `${origin}/sandbox-control/sbx_1/startup-failure`,
  ]) {
    const denied = request(target);
    await expect(access.fetchHost(denied, send)).rejects.toThrow('host request denied');
    expect(denied.headers.has('cf-access-client-secret')).toBe(false);
  }
  const response = await access.fetchHost(request(`${origin}/aws-egress/sbx_1/audit`), send);
  expect(response.status).toBe(302);
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(send).toHaveBeenCalledOnce();
});

it.each([
  ['GET', '/api/user', true],
  ['GET', '/api/gateway/api/organizations/org_1/models', true],
  ['POST', '/api/gateway/v1/responses', true],
  ['POST', '/api/session/ses_1/ingest', true],
  ['GET', '/sandbox-preview-tunnel/sbx_1', true],
  ['POST', '/sandbox-preview-tunnel/sbx_1', false],
  ['GET', '/sandbox-preview-tunnel/sbx_1/extra', false],
  ['POST', '/api/user', false],
  ['GET', '/api/gateway/admin/models', false],
  ['POST', '/api/trpc/cloudAgent.sendMessage', false],
  ['GET', '/api/internal/byoc/connections', false],
])('applies Access credentials to %s %s only if allowed', (method, path, allowed) => {
  const access = createEc2TestAccess(config, origin);
  const headers = new Headers({ authorization: 'Bearer fixture_grant' });
  expect(access.authorizeWorkload(new URL(path, origin), method, headers)).toBe(allowed);
  expect(headers.has('cf-access-client-secret')).toBe(allowed);
  expect(headers.get('authorization')).toBe('Bearer fixture_grant');
});
