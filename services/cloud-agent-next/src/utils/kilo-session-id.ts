const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

let counter = 0;

function descendingTimestampHex(): string {
  const tick = BigInt(Date.now()) * 0x1000n + BigInt(counter);
  counter = (counter + 1) & 0xfff;

  // 6-byte mask (48 bits) — invert so newer timestamps sort first
  const descending = ~tick & 0xffff_ffff_ffffn;

  return descending.toString(16).padStart(12, '0');
}

function randomBase62(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);

  let result = '';
  for (let i = 0; i < length; i++) {
    result += BASE62[bytes[i] % 62];
  }
  return result;
}

export function generateKiloSessionId(): string {
  return `ses_${descendingTimestampHex()}${randomBase62(14)}`;
}
