import type { webcrypto } from 'node:crypto';

// `@kilocode/verify` and `@kilocode/sts-contracts` name the Web Crypto types as globals, as the
// Workers and DOM libraries declare them. Node declares them under `crypto.webcrypto` only, and the
// DOM library would clash with Node's own stream types, so this file names the two that are used.
declare global {
  type CryptoKey = webcrypto.CryptoKey;
  type BufferSource = webcrypto.BufferSource;
}
