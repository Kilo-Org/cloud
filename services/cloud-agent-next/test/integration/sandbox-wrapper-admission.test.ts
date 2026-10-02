import { env, reset } from 'cloudflare:test';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSecret } from '../../src/auth.js';
import {
  mintSandboxLaunchCredential,
  verifySandboxLaunchCredential,
} from '../../src/sandbox-control/credential.js';
import { admitSandboxWrapperUpgrade } from '../../src/sandbox-control/socket-admission.js';
import type { Env } from '../../src/types.js';

const sandboxId = 'sbx_admission';
const allocationId = '00000000-0000-4000-8000-000000000001';
const credential = 'a'.repeat(64);
const claims = { sandboxId, allocationId, credential };
const bindings = env as Env;

afterEach(async () => {
  await reset();
});

describe('Worker wrapper socket admission', () => {
  it.each([
    'missing',
    'malformed',
    'oversized',
    'forged',
    'wrong-sandbox',
    'wrong-purpose',
    'invalid-allocation',
    'rotated-key',
    'wrong-algorithm',
    'clock-claims',
  ])('never resolves a DO stub for %s', async scenario => {
    const secret = await resolveSecret(bindings.NEXTAUTH_SECRET);
    if (!secret) throw new Error('Test signing secret unavailable');
    const token =
      scenario === 'wrong-sandbox'
        ? mintSandboxLaunchCredential({ ...claims, sandboxId: 'sbx_other' }, secret)
        : scenario === 'wrong-purpose'
          ? jwt.sign({ ...claims, type: 'stream_ticket', aud: 'cloud-agent-stream' }, secret)
          : scenario === 'invalid-allocation'
            ? jwt.sign(
                {
                  ...claims,
                  allocationId: 'invalid',
                  type: 'control_wrapper_launch',
                  aud: 'cloud-agent-control-wrapper-launch',
                },
                secret,
                { noTimestamp: true }
              )
            : scenario === 'rotated-key'
              ? mintSandboxLaunchCredential(claims, 'retired-signing-key')
              : scenario === 'wrong-algorithm'
                ? jwt.sign(
                    {
                      ...claims,
                      type: 'control_wrapper_launch',
                      aud: 'cloud-agent-control-wrapper-launch',
                    },
                    secret,
                    { algorithm: 'HS384', noTimestamp: true }
                  )
                : scenario === 'clock-claims'
                  ? jwt.sign(
                      {
                        ...claims,
                        type: 'control_wrapper_launch',
                        aud: 'cloud-agent-control-wrapper-launch',
                      },
                      secret,
                      { expiresIn: 60 }
                    )
                  : scenario === 'oversized'
                    ? 'x'.repeat(2049)
                    : 'forged-nonempty';
    const getByName = vi.fn(() => {
      throw new Error('Unauthorized stub resolution');
    });
    const request = new Request(`https://worker.test/sandbox-control/${sandboxId}`, {
      headers: {
        Upgrade: 'websocket',
        ...(scenario === 'missing'
          ? {}
          : {
              Authorization: scenario === 'malformed' ? 'Basic value' : `Bearer ${token}`,
            }),
      },
    });
    const response = await admitSandboxWrapperUpgrade(
      request,
      {
        NEXTAUTH_SECRET: bindings.NEXTAUTH_SECRET,
        SANDBOX_CONTROL: { getByName } as unknown as Env['SANDBOX_CONTROL'],
      },
      sandboxId
    );
    expect(getByName).not.toHaveBeenCalled();
    if (['missing', 'malformed', 'oversized'].includes(scenario)) {
      expect(response.status).toBe(401);
    } else {
      expect(response.status).toBe(101);
      const socket = response.webSocket;
      if (!socket) throw new Error('Missing rejection socket');
      const messages: unknown[] = [];
      const closed = new Promise<number>(resolve =>
        socket.addEventListener('close', event => resolve(event.code))
      );
      socket.addEventListener('message', event => {
        messages.push(JSON.parse(String(event.data)));
      });
      socket.accept();
      expect(await closed).toBe(1008);
      expect(messages).toEqual([{ type: 'shutdown', reason: 'hello_rejected' }]);
    }
  });

  it('does not resolve a stub when the existing signing secret is temporarily unavailable', async () => {
    const getByName = vi.fn();
    const response = await admitSandboxWrapperUpgrade(
      new Request('https://worker.test/sandbox-control/sbx_admission', {
        headers: { Upgrade: 'websocket', Authorization: 'Bearer presented' },
      }),
      {
        NEXTAUTH_SECRET: {
          get: async () => {
            throw new Error('Secret unavailable');
          },
        },
        SANDBOX_CONTROL: { getByName } as unknown as Env['SANDBOX_CONTROL'],
      },
      sandboxId
    );
    expect(response.status).toBe(503);
    expect(getByName).not.toHaveBeenCalled();
  });

  it.each(['', 'not valid', 'x'.repeat(257)])(
    'rejects an invalid sandbox ID before resolving a stub (case %#)',
    async id => {
      const getByName = vi.fn();
      const response = await admitSandboxWrapperUpgrade(
        new Request('https://worker.test/sandbox-control/invalid', {
          headers: { Upgrade: 'websocket' },
        }),
        {
          NEXTAUTH_SECRET: bindings.NEXTAUTH_SECRET,
          SANDBOX_CONTROL: { getByName } as unknown as Env['SANDBOX_CONTROL'],
        },
        id
      );
      expect(response.status).toBe(400);
      expect(getByName).not.toHaveBeenCalled();
    }
  );

  it('forwards only verified launch credentials, without a clock expiry', async () => {
    const secret = await resolveSecret(bindings.NEXTAUTH_SECRET);
    if (!secret) throw new Error('Test signing secret unavailable');
    const token = mintSandboxLaunchCredential(claims, secret);
    expect(jwt.decode(token)).toEqual({
      ...claims,
      type: 'control_wrapper_launch',
      aud: 'cloud-agent-control-wrapper-launch',
    });
    expect(verifySandboxLaunchCredential(token, secret)).toMatchObject(claims);
    const fetch = vi.fn().mockResolvedValue(new Response('forwarded'));
    const getByName = vi.fn().mockReturnValue({ fetch });
    const request = new Request(`https://worker.test/sandbox-control/${sandboxId}`, {
      headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` },
    });
    const response = await admitSandboxWrapperUpgrade(
      request,
      {
        NEXTAUTH_SECRET: bindings.NEXTAUTH_SECRET,
        SANDBOX_CONTROL: { getByName } as unknown as Env['SANDBOX_CONTROL'],
      },
      sandboxId
    );
    expect(await response.text()).toBe('forwarded');
    expect(getByName).toHaveBeenCalledExactlyOnceWith(sandboxId);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
  });
});
