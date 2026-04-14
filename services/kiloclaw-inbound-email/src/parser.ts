import PostalMime, { type Address, type RawEmail } from 'postal-mime';

export type ParsedInboundEmail = {
  messageId: string | null;
  from: string;
  subject: string;
  text: string;
};

function firstAddress(address: Address | undefined): string | null {
  if (!address) return null;
  if (typeof address.address === 'string' && address.address.trim()) return address.address.trim();

  for (const mailbox of address.group ?? []) {
    if (mailbox.address.trim()) return mailbox.address.trim();
  }

  return null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/&#(\d+);/g, (_match, codePoint: string) =>
      String.fromCodePoint(Number.parseInt(codePoint, 10))
    )
    .replace(/&#x([\da-f]+);/gi, (_match, codePoint: string) =>
      String.fromCodePoint(Number.parseInt(codePoint, 16))
    );
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/[\t ]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
  ).trim();
}

function normalizeText(text: string | undefined, html: string | undefined): string {
  const trimmedText = text?.trim() ?? '';
  if (trimmedText.length > 0) return trimmedText;

  const trimmedHtml = html ? htmlToText(html) : '';
  return trimmedHtml.length > 0 ? trimmedHtml : '(No plain text body)';
}

export async function parseRawEmail(raw: RawEmail): Promise<ParsedInboundEmail> {
  const email = await PostalMime.parse(raw);

  return {
    messageId: email.messageId?.trim() ?? null,
    from: firstAddress(email.from) ?? 'unknown',
    subject: email.subject ?? '',
    text: normalizeText(email.text, email.html),
  };
}

function rawBytes(raw: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (typeof raw === 'string') return new TextEncoder().encode(raw);
  if (raw instanceof Uint8Array) return raw;
  return new Uint8Array(raw);
}

export async function stableMessageId(raw: string | ArrayBuffer | Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', rawBytes(raw));
  const hex = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}
