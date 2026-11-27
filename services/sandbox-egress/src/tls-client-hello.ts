import type { Socket } from 'node:net';
import { egressDomainSchema } from '@kilocode/worker-utils/egress-allowlist';

const MAX_CLIENT_HELLO_BYTES = 32_768;
const MAX_TLS_RECORD_BYTES = 16_384;
const MAX_HELLO_RECORDS = 16;

function invalid(): never {
  throw new Error('Invalid TLS ClientHello');
}

function parseExtensions(hello: Buffer): string {
  // Protocol version, random, session ID, cipher suites and compression methods.
  let offset = 34;
  if (hello.length < offset + 1 || hello.readUInt16BE() !== 0x0303) invalid();
  const sessionLength = hello[offset++];
  if (sessionLength > 32) invalid();
  offset += sessionLength;
  if (offset + 2 > hello.length) invalid();
  const ciphersLength = hello.readUInt16BE(offset);
  if (ciphersLength < 2 || ciphersLength % 2 !== 0) invalid();
  offset += 2 + ciphersLength;
  if (offset + 1 > hello.length) invalid();
  const compressionLength = hello[offset++];
  if (compressionLength === 0) invalid();
  offset += compressionLength;
  if (offset + 2 > hello.length || hello.readUInt16BE(offset) !== hello.length - offset - 2)
    invalid();
  offset += 2;
  let hostname: string | undefined;
  while (offset < hello.length) {
    if (offset + 4 > hello.length) invalid();
    const type = hello.readUInt16BE(offset);
    const length = hello.readUInt16BE(offset + 2);
    offset += 4;
    if (offset + length > hello.length || type === 0xfe0d) invalid();
    if (type === 0) {
      // The policy needs one visible DNS authority. Do not guess among multiple names.
      if (
        hostname ||
        length < 6 ||
        hello.readUInt16BE(offset) !== length - 2 ||
        hello[offset + 2] !== 0 ||
        hello.readUInt16BE(offset + 3) !== length - 5
      )
        invalid();
      const name = hello.toString('latin1', offset + 5, offset + length);
      if (!/^[A-Za-z0-9.-]{1,253}$/.test(name)) invalid();
      hostname = egressDomainSchema.safeParse(name).data;
      if (hostname === undefined) invalid();
    }
    offset += length;
  }
  return hostname ?? invalid();
}

/** Accept a ClientHello split across TLS records. Return undefined for an incomplete prefix. */
export function tlsClientHelloHostname(records: Buffer): string | undefined {
  if (records.length > MAX_CLIENT_HELLO_BYTES) invalid();
  const fragments: Buffer[] = [];
  let length = 0;
  let helloLength: number | undefined;
  for (let offset = 0; offset + 5 <= records.length;) {
    const type = records[offset];
    const version = records.readUInt16BE(offset + 1);
    const recordLength = records.readUInt16BE(offset + 3);
    offset += 5;
    if (
      type !== 22 ||
      version < 0x0301 ||
      version > 0x0303 ||
      recordLength === 0 ||
      recordLength > MAX_TLS_RECORD_BYTES
    )
      invalid();
    if (offset + recordLength > records.length) return undefined;
    fragments.push(records.subarray(offset, offset + recordLength));
    if (fragments.length > MAX_HELLO_RECORDS) invalid();
    length += recordLength;
    offset += recordLength;
    if (length < 4) continue;
    if (helloLength === undefined) {
      const header = Buffer.concat(fragments, 4);
      if (header[0] !== 1) invalid();
      helloLength = header.readUIntBE(1, 3);
      if (helloLength + 4 > MAX_CLIENT_HELLO_BYTES) invalid();
    }
    if (helloLength + 4 <= length)
      return parseExtensions(Buffer.concat(fragments, helloLength + 4).subarray(4));
  }
  return undefined;
}

/** Keep the socket paused. The caller must forward the exact bytes or destroy the connection. */
export function readTlsClientHello(socket: Socket, signal: AbortSignal) {
  return new Promise<{ hostname: string; head: Buffer }>((resolve, reject) => {
    const buffer = Buffer.allocUnsafe(MAX_CLIENT_HELLO_BYTES);
    let length = 0;
    function cleanup() {
      socket.off('readable', read);
      socket.off('end', abort);
      signal.removeEventListener('abort', abort);
    }
    function abort() {
      cleanup();
      reject(new Error('TLS ClientHello unavailable'));
    }
    function read() {
      const bytes: unknown = socket.read();
      if (bytes === null) return;
      try {
        if (!Buffer.isBuffer(bytes)) invalid();
        if (length + bytes.length > buffer.length) invalid();
        bytes.copy(buffer, length);
        length += bytes.length;
        const head = buffer.subarray(0, length);
        const hostname = tlsClientHelloHostname(head);
        if (hostname !== undefined) {
          cleanup();
          resolve({ hostname, head });
          return;
        }
        if (length === buffer.length) invalid();
      } catch {
        abort();
      }
    }
    if (signal.aborted) {
      abort();
      return;
    }
    socket.pause();
    socket.on('readable', read);
    socket.once('end', abort);
    signal.addEventListener('abort', abort, { once: true });
    read();
  });
}
