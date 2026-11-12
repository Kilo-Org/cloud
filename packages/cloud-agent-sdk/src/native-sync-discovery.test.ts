import type { NativeInstanceReply, NativePresenceConnection } from './native-sync';
import { listNativeModels } from './native-sync-discovery';

const catalogRevision = 'a'.repeat(64);

const model = {
  id: 'model-1',
  providerID: 'provider',
  name: 'First model',
  limit: { context: 128000, input: 120000, output: 8000 },
  variants: [{ id: 'thinking' }],
};
function replied(result: unknown) {
  return {
    commandID: 'command',
    instanceID: 'host',
    status: 'replied' as const,
    body: {
      status: 'succeeded',
      result:
        typeof result === 'object' && result !== null ? { catalogRevision, ...result } : result,
    },
  };
}
function connection() {
  return {
    command: jest.fn<
      Promise<NativeInstanceReply>,
      Parameters<NativePresenceConnection['command']>
    >(),
  };
}

it('collects every page and retains limits and variants without the old catalog truncation', async () => {
  const host = connection();
  const first = Array.from({ length: 200 }, (_, index) => ({ ...model, id: `model-${index}` }));
  host.command.mockResolvedValueOnce(replied({ models: first, nextCursor: 200 }));
  host.command.mockResolvedValueOnce(
    replied({ models: [{ ...model, id: 'last' }], nextCursor: null })
  );
  const models = await listNativeModels(host, 'host');
  expect(models).toEqual([...first, { ...model, id: 'last' }]);
  expect(host.command.mock.calls).toEqual([
    ['host', 'list_models', {}],
    ['host', 'list_models', { cursor: 200, catalogRevision }],
  ]);
});

it('distinguishes an empty successful catalog from discovery failure', async () => {
  const host = connection();
  host.command.mockResolvedValueOnce(replied({ models: [], nextCursor: null }));
  await expect(listNativeModels(host, 'host')).resolves.toEqual([]);
});

it.each([
  undefined,
  {},
  { models: [] },
  { models: [], nextCursor: -1 },
  { models: [], nextCursor: 1.5 },
  { models: [], nextCursor: '1' },
  { models: [], nextCursor: Number.MAX_SAFE_INTEGER + 1 },
  { models: [], nextCursor: null, catalogRevision: undefined },
  { models: [], nextCursor: null, catalogRevision: '' },
  { models: [], nextCursor: null, catalogRevision: 'not-a-sha256' },
  { models: [], nextCursor: null, catalogRevision: 123 },
  { models: [null], nextCursor: null },
  {
    models: [{ id: 'legacy', providerID: 'provider', name: 'Missing metadata' }],
    nextCursor: null,
  },
  { models: [{ ...model, limit: { context: '128000', output: 8000 } }], nextCursor: null },
  { models: [{ ...model, variants: ['thinking'] }], nextCursor: null },
])('rejects malformed model pages: %j', async page => {
  const host = connection();
  host.command.mockResolvedValueOnce(replied(page));
  await expect(listNativeModels(host, 'host')).rejects.toThrow();
  expect(host.command).toHaveBeenCalledTimes(1);
});

it.each([0, 1, 2])(
  'rejects a cursor that does not advance from the requested offset: %s',
  async nextCursor => {
    const host = connection();
    host.command.mockResolvedValueOnce(replied({ models: [model, model, model], nextCursor: 3 }));
    host.command.mockResolvedValueOnce(replied({ models: [model], nextCursor }));
    await expect(listNativeModels(host, 'host')).rejects.toThrow('cursor did not advance');
    expect(host.command).toHaveBeenCalledTimes(2);
  }
);

it('rejects an initial zero cursor instead of looping', async () => {
  const host = connection();
  host.command.mockResolvedValueOnce(replied({ models: [], nextCursor: 0 }));
  await expect(listNativeModels(host, 'host')).rejects.toThrow('cursor did not advance');
});

it.each(['unknown reply', 'unknown outcome', 'failed outcome', 'malformed outcome'])(
  'does not return a partial catalog after a later %s',
  async kind => {
    const host = connection();
    host.command.mockResolvedValueOnce(replied({ models: [model], nextCursor: 1 }));
    if (kind === 'unknown reply') {
      host.command.mockResolvedValueOnce({
        commandID: 'command',
        instanceID: 'host',
        status: 'unknown',
      });
    } else {
      const body =
        kind === 'unknown outcome'
          ? { status: 'unknown' }
          : kind === 'failed outcome'
            ? { status: 'failed', error: { message: 'Host cannot list models' } }
            : { status: 'delivered' };
      host.command.mockResolvedValueOnce({ ...replied(null), body });
    }
    await expect(listNativeModels(host, 'host')).rejects.toThrow();
    expect(host.command).toHaveBeenCalledTimes(2);
  }
);

it.each([2, 5])('rejects a forward cursor that skips records: %s', async nextCursor => {
  const host = connection();
  host.command.mockResolvedValueOnce(replied({ models: [model], nextCursor }));
  await expect(listNativeModels(host, 'host')).rejects.toThrow('cursor skipped model records');
  expect(host.command).toHaveBeenCalledTimes(1);
});

it('allows the outcome wrapper above a 48 KiB model entry', async () => {
  const host = connection();
  const largeModel = {
    ...model,
    name: 'x'.repeat(48 * 1024 - JSON.stringify(model).length + model.name.length),
  };
  host.command.mockResolvedValueOnce(replied({ models: [largeModel], nextCursor: null }));
  await expect(listNativeModels(host, 'host')).resolves.toEqual([largeModel]);
});

it('rejects an oversized page rather than parsing an unbounded catalog chunk', async () => {
  const host = connection();
  host.command.mockResolvedValueOnce(
    replied({ models: [{ ...model, name: 'x'.repeat(60 * 1024) }], nextCursor: null })
  );
  await expect(listNativeModels(host, 'host')).rejects.toThrow('page exceeded the byte limit');
});

it('rejects a catalog exceeding the retained byte budget without returning partial models', async () => {
  const host = connection();
  const largeModel = { ...model, name: 'x'.repeat(48 * 1024 - 1024) };
  host.command.mockImplementation(async (_instance, _type, body) => {
    const cursor = typeof body === 'object' && body !== null && 'cursor' in body ? body.cursor : 0;
    if (typeof cursor !== 'number') throw new Error('Unexpected discovery cursor');
    return replied({ models: [largeModel], nextCursor: cursor + 1 });
  });
  await expect(listNativeModels(host, 'host')).rejects.toThrow('catalog byte limit');
  expect(host.command.mock.calls.length).toBeLessThan(100);
});

it('bounds tiny-page accumulation even when every cursor advances correctly', async () => {
  const host = connection();
  host.command.mockImplementation(async (_instance, _type, body) => {
    const cursor = typeof body === 'object' && body !== null && 'cursor' in body ? body.cursor : 0;
    if (typeof cursor !== 'number') throw new Error('Unexpected discovery cursor');
    return replied({ models: [model], nextCursor: cursor + 1 });
  });
  await expect(listNativeModels(host, 'host')).rejects.toThrow('page limit');
  expect(host.command).toHaveBeenCalledTimes(1024);
});

it('rejects a changed catalog revision before accepting a later page', async () => {
  const host = connection();
  host.command.mockResolvedValueOnce(replied({ models: [model], nextCursor: 1 }));
  host.command.mockResolvedValueOnce(
    replied({
      models: [{ ...model, id: 'replacement' }],
      nextCursor: null,
      catalogRevision: 'b'.repeat(64),
    })
  );
  await expect(listNativeModels(host, 'host')).rejects.toThrow(
    'Model catalog changed. Refresh host options to try again.'
  );
  expect(host.command.mock.calls).toEqual([
    ['host', 'list_models', {}],
    ['host', 'list_models', { cursor: 1, catalogRevision }],
  ]);
});

it('surfaces catalog_changed as an explicit refresh without retry', async () => {
  const error = { code: 'catalog_changed', message: 'Catalog was refreshed on the host' };
  const host = connection();
  host.command.mockResolvedValueOnce(replied({ models: [model], nextCursor: 1 }));
  host.command.mockResolvedValueOnce({
    ...replied(null),
    body: { status: 'failed', error },
  });
  await expect(listNativeModels(host, 'host')).rejects.toThrow(
    'Model catalog changed. Refresh host options to try again.'
  );
  expect(host.command).toHaveBeenCalledTimes(2);
});
