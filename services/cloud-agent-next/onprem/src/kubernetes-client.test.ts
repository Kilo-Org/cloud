import { expect, spyOn, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createKubernetesClient } from './kubernetes.js';

test('ledger deletion transmits UID and resourceVersion preconditions and rejects conflicts', async () => {
  const directory = '/var/run/secrets/kubernetes.io/serviceaccount';
  const read = spyOn(fs, 'readFile').mockImplementation((async path => {
    if (path === `${directory}/token`) return 'test-token'.repeat(4);
    if (path === `${directory}/ca.crt`) return 'test-ca';
    throw new Error('unexpected_test_read');
  }) as typeof fs.readFile);
  const requests: unknown[] = [];
  let status = 200;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (
    url: string | URL | Request,
    init?: RequestInit
  ) => {
    expect(url).toBe('https://kubernetes.default.svc/api/v1/namespaces/system/configmaps/ledger');
    expect(init?.method).toBe('DELETE');
    if (typeof init?.body !== 'string') throw new Error('unexpected_test_body');
    requests.push(JSON.parse(init.body));
    return Response.json({ kind: 'Status' }, { status });
  }) as typeof globalThis.fetch);
  try {
    const kube = createKubernetesClient();
    const path = '/api/v1/namespaces/system/configmaps/ledger';
    await kube.remove(path, 'expected-uid', 0, 'expected-version');
    status = 409;
    await rejects(kube.remove(path, 'expected-uid', 0, 'expected-version'), { status: 409 });
    status = 404;
    await kube.remove(path, 'expected-uid', 0, 'expected-version');
    expect(requests).toEqual(
      Array.from({ length: 3 }, () => ({
        apiVersion: 'v1',
        kind: 'DeleteOptions',
        gracePeriodSeconds: 0,
        preconditions: { uid: 'expected-uid', resourceVersion: 'expected-version' },
      }))
    );
  } finally {
    fetch.mockRestore();
    read.mockRestore();
  }
});
