import { describe, expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import type { z } from 'zod';
import { listResources } from './kubernetes-pagination.js';
import {
  KubernetesError,
  configMapSchema,
  readBoundedJson,
  type KubernetesClient,
} from './kubernetes.js';
import { ledgerRecord } from './runtime-test-fixtures.js';

const path = '/api/v1/namespaces/system/configmaps?labelSelector=kilo.ai%2Fcomponent%3Dledger';

function pages(values: (unknown | Error | null)[]) {
  const requests: string[] = [];
  const kube: Pick<KubernetesClient, 'get'> = {
    async get<T>(requested: string, schema: z.ZodType<T>): Promise<T | null> {
      requests.push(requested);
      const value = values.shift();
      if (value instanceof Error) throw value;
      return value == null ? null : schema.parse(value);
    },
  };
  return { kube, requests };
}

function page(continuation = '', resourceVersion = '7') {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMapList',
    metadata: { continue: continuation, resourceVersion },
    items: [ledgerRecord().resource],
  };
}

describe('bounded Kubernetes discovery', () => {
  test('discovers history beyond both the old 8 MiB response and 4096-record limits', async () => {
    const resource = ledgerRecord().resource;
    const count = 4300;
    let totalBytes = 0;
    let maxPageBytes = 0;
    let requests = 0;
    const kube: Pick<KubernetesClient, 'get'> = {
      async get<T>(requested: string, schema: z.ZodType<T>): Promise<T | null> {
        const query = new URL(`https://kubernetes.default.svc${requested}`).searchParams;
        expect(query.get('labelSelector')).toBe('kilo.ai/component=ledger');
        const limit = Number(query.get('limit'));
        expect(limit).toBeGreaterThan(0);
        expect(limit).toBeLessThanOrEqual(8);
        const start = Number(query.get('continue') ?? 0);
        const end = Math.min(start + limit, count);
        const body = JSON.stringify({
          ...page(end < count ? String(end) : ''),
          items: Array.from({ length: end - start }, (_, offset) => ({
            ...resource,
            metadata: {
              ...resource.metadata,
              name: `ledger-${start + offset}`,
              uid: `uid-${start + offset}`,
            },
            data: { ...resource.data, history: 'x'.repeat(2048) },
          })),
        });
        requests++;
        totalBytes += Buffer.byteLength(body);
        maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(body));
        return schema.parse(await readBoundedJson(new Response(body), 8 * 1_048_576));
      },
    };
    const result = await listResources(kube, path, configMapSchema, 'ConfigMap');
    expect(result).toHaveLength(count);
    expect(new Set(result.map(item => item.metadata.uid)).size).toBe(count);
    expect(totalBytes).toBeGreaterThan(8 * 1_048_576);
    expect(maxPageBytes).toBeLessThan(8 * 1_048_576);
    expect(requests).toBe(Math.ceil(count / 8));
  });

  test('encodes opaque continuation tokens without changing list selectors', async () => {
    const token = 'next+/=&token';
    const fake = pages([page(token), page()]);
    expect(await listResources(fake.kube, path, configMapSchema, 'ConfigMap')).toHaveLength(2);
    const next = new URL(`https://kubernetes.default.svc${fake.requests[1]}`).searchParams;
    expect(next.get('continue')).toBe(token);
    expect(next.get('labelSelector')).toBe('kilo.ai/component=ledger');
  });

  test.each([
    ['expired snapshot', new KubernetesError(410)],
    ['missing later page', null],
    ['invalid later page', { ...page(), items: [{}] }],
    ['changed snapshot', page('', '8')],
    ['repeated token', page('next')],
    ['missing snapshot version', { ...page(), metadata: {} }],
    [
      'ignored page limit',
      { ...page(), items: Array.from({ length: 9 }, () => ledgerRecord().resource) },
    ],
  ])('does not publish a partial result for %s', async (_name, next) => {
    const fake = pages([page('next'), next]);
    const previous = [ledgerRecord().resource];
    let discovered = previous;
    await rejects(async () => {
      discovered = await listResources(fake.kube, path, configMapSchema, 'ConfigMap');
    });
    expect(discovered).toBe(previous);
    expect(fake.requests).toHaveLength(2);
  });

  test('an oversized single page is rejected before it becomes a discovery result', async () => {
    await rejects(
      readBoundedJson(new Response(JSON.stringify(page())), 64),
      new Error('response_body_invalid')
    );
  });
});
