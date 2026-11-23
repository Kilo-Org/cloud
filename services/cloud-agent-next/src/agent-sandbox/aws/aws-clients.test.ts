import { describe, expect, it } from 'vitest';
import {
  createMicrovmClient,
  AwsMicrovmRunRejectedError,
  type MicrovmRunRequest,
} from './microvm-client.js';
import { createAwsObjectStore } from './object-store.js';

const credentials = {
  accessKeyId: 'ASIATEST000000000000',
  secretAccessKey: 'test-secret',
  sessionToken: 'test-token',
};
const request: MicrovmRunRequest = {
  clientToken: 'allocation-1',
  imageIdentifier: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:kilo',
  imageVersion: '1.0',
  ingressNetworkConnectors: [
    'arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:NO_INGRESS',
  ],
  egressNetworkConnectors: ['arn:aws:lambda:us-east-1:123456789012:network-connector:customer:1'],
  logging: { disabled: {} },
  maximumDurationInSeconds: 28800,
  runHookPayload: '{"capability":"test"}',
};

describe('AWS sandbox clients', () => {
  it.each([
    [403, 'AccessDeniedException', true],
    [400, 'ValidationException', true],
    [409, 'ConflictException', false],
    [503, 'InternalServerException', false],
  ])(
    'classifies Run refusal %s %s without treating inspection as submission',
    async (status, code, rejected) => {
      const client = createMicrovmClient({
        credentials,
        region: 'us-east-1',
        fetch: async () => new Response(null, { status, headers: { 'x-amzn-errortype': code } }),
      });
      const failure = await client.run(request).catch(error => error);
      expect(failure instanceof AwsMicrovmRunRejectedError).toBe(rejected);
      await expect(client.get('microvm-123')).rejects.not.toBeInstanceOf(
        AwsMicrovmRunRejectedError
      );
    }
  );

  it('retains unexpected networking and runtime authority for adapter rejection', async () => {
    const response = {
      microvmId: 'microvm-123',
      imageArn: request.imageIdentifier,
      imageVersion: '1.0',
      state: 'RUNNING',
      maximumDurationInSeconds: 28800,
      ingressNetworkConnectors: ['unexpected-ingress'],
      egressNetworkConnectors: ['unexpected-egress'],
      executionRoleArn: 'arn:aws:iam::123456789012:role/unexpected',
      idlePolicy: {
        autoResumeEnabled: true,
        maxIdleDurationSeconds: 10,
        suspendedDurationSeconds: 10,
      },
    };
    const client = createMicrovmClient({
      credentials,
      region: 'us-east-1',
      fetch: async () => Response.json(response),
    });
    expect(await client.get('microvm-123')).toEqual(response);
  });
  it('runs with no execution role or idle policy, then reads and terminates the returned identity', async () => {
    let state = 'PENDING';
    const client = createMicrovmClient({
      credentials,
      region: 'us-east-1',
      fetch: async input => {
        if (input.method === 'POST') {
          const body = await input.json();
          expect(body).toEqual(request);
          expect(body).not.toHaveProperty('executionRoleArn');
          expect(body).not.toHaveProperty('idlePolicy');
        } else {
          expect(new URL(input.url).pathname).toBe('/2025-09-09/microvms/microvm-123');
          if (input.method === 'DELETE') {
            state = 'TERMINATED';
            return new Response('{}');
          }
        }
        return Response.json({
          microvmId: 'microvm-123',
          imageArn: request.imageIdentifier,
          imageVersion: '1.0',
          state,
          maximumDurationInSeconds: 28800,
          ingressNetworkConnectors: request.ingressNetworkConnectors,
          egressNetworkConnectors: request.egressNetworkConnectors,
          executionRoleArn: null,
          idlePolicy: null,
        });
      },
    });
    expect((await client.run(request)).state).toBe('PENDING');
    expect((await client.get('microvm-123')).state).toBe('PENDING');
    await client.terminate('microvm-123');
    expect((await client.get('microvm-123')).state).toBe('TERMINATED');
    await expect(client.get('../other')).rejects.toThrow('Invalid MicroVM identity');
  });

  it('prevents launch and archive capabilities from reaching proxy-private material', async () => {
    const store = createAwsObjectStore({
      credentials,
      region: 'us-east-1',
      bucket: 'customer-artifacts',
      fetch: async input => {
        expect(input.method).toBe('PUT');
        expect(input.headers.get('if-none-match')).toBe('*');
        expect(await input.text()).toBe('launch');
        return new Response(null, { status: 200 });
      },
    });
    await store.putLaunch('kilo/launch/allocation-1.json', 'launch');
    for (const key of [
      'proxy/private/ca.key',
      'kilo/launch/../proxy.json',
      'kilo/archives//other.tar.gz',
    ]) {
      await expect(store.downloadUrl(key, 600)).rejects.toThrow('Invalid AWS artifact key');
    }
    await expect(store.uploadUrl('kilo/launch/allocation-1.json', 600)).rejects.toThrow(
      'Invalid AWS archive key'
    );
  });
});
