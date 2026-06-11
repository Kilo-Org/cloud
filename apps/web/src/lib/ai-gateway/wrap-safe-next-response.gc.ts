import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

async function main() {
  assert.ok(global.gc);

  const { wrapInSafeNextResponse } = await import('./llm-proxy-helpers');
  const chunks = ['first', 'second', 'third'];
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write(chunks[0]);
    setTimeout(() => response.write(chunks[1]), 25);
    setTimeout(() => response.end(chunks[2]), 50);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address() as AddressInfo;
    const wrapped = await (async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}`);
      const siblingA = response.clone();
      const siblingB = response.clone();
      return {
        response: wrapInSafeNextResponse(response),
        siblings: [siblingA.text(), siblingB.text()],
      };
    })();

    for (let index = 0; index < 10; index++) {
      global.gc();
      await new Promise(resolve => setImmediate(resolve));
    }

    const [body, ...siblings] = await Promise.all([wrapped.response.text(), ...wrapped.siblings]);
    assert.deepEqual(siblings, [chunks.join(''), chunks.join('')]);
    assert.equal(body, chunks.join(''));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  }
}

void main();
