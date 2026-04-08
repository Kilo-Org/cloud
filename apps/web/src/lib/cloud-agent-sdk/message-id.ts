// Kilo format: msg_ + 6 bytes as hex (12 chars, time-based) + 14 base62 chars (random)
export function generateMessageId(): string {
  const timeBytes = new Uint8Array(6);
  const now = BigInt(Date.now()) * BigInt(0x1000);
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }
  const hex = Array.from(timeBytes, b => b.toString(16).padStart(2, '0')).join('');
  const base62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(14)), b => base62[b % 62]).join('');
  return `msg_${hex}${rand}`;
}
