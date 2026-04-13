export type ParsedInboundEmail = {
  messageId: string | null;
  from: string;
  subject: string;
  text: string;
};

type ParsedHeaders = {
  headers: Record<string, string>;
  body: string;
};

const HEADER_BODY_SPLIT = /\r?\n\r?\n/;

function splitHeaders(raw: string): ParsedHeaders {
  const match = HEADER_BODY_SPLIT.exec(raw);
  if (!match) return { headers: {}, body: raw };

  const headerText = raw.slice(0, match.index);
  const body = raw.slice(match.index + match[0].length);
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ');
  const headers: Record<string, string> = {};

  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  }

  return { headers, body };
}

function decodeMimeWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g,
    (_match: string, charset: string, encoding: string, encoded: string): string => {
      try {
        const lowerCharset = charset.toLowerCase();
        if (lowerCharset !== 'utf-8' && lowerCharset !== 'us-ascii') return encoded;
        if (encoding.toLowerCase() === 'b') {
          const binary = atob(encoded);
          const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
          return new TextDecoder().decode(bytes);
        }
        return decodeQuotedPrintable(encoded.replaceAll('_', ' '));
      } catch {
        return encoded;
      }
    }
  );
}

function decodeQuotedPrintable(value: string): string {
  const withoutSoftBreaks = value.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < withoutSoftBreaks.length; i++) {
    const char = withoutSoftBreaks[i];
    if (char === '=' && /^[0-9a-fA-F]{2}$/.test(withoutSoftBreaks.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(withoutSoftBreaks.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(char.charCodeAt(0));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodeTransferBody(body: string, encoding: string | undefined): string {
  const normalized = encoding?.toLowerCase().trim();
  if (normalized === 'base64') {
    try {
      const binary = atob(body.replace(/\s+/g, ''));
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return body;
    }
  }
  if (normalized === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

function contentTypeParameter(contentType: string | undefined, name: string): string | null {
  if (!contentType) return null;
  const pattern = new RegExp(`${name}=(?:"([^"]+)"|([^;]+))`, 'i');
  const match = pattern.exec(contentType);
  return match?.[1]?.trim() ?? match?.[2]?.trim() ?? null;
}

function isTextPlain(contentType: string | undefined): boolean {
  return (contentType ?? 'text/plain').toLowerCase().startsWith('text/plain');
}

function extractPlainTextFromMultipart(body: string, boundary: string): string | null {
  const delimiter = `--${boundary}`;
  for (const part of body.split(delimiter)) {
    const trimmed = part.replace(/^\r?\n/, '').replace(/\r?\n--\r?\n?$/, '');
    if (!trimmed || trimmed === '--') continue;
    const parsed = splitHeaders(trimmed);
    if (!isTextPlain(parsed.headers['content-type'])) continue;
    return decodeTransferBody(parsed.body, parsed.headers['content-transfer-encoding']).trim();
  }
  return null;
}

function stripAddressName(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return (match?.[1] ?? value).trim();
}

export function parseRawEmail(raw: string): ParsedInboundEmail {
  const parsed = splitHeaders(raw);
  const contentType = parsed.headers['content-type'];
  const boundary = contentTypeParameter(contentType, 'boundary');
  const text = boundary
    ? extractPlainTextFromMultipart(parsed.body, boundary)
    : decodeTransferBody(parsed.body, parsed.headers['content-transfer-encoding']).trim();

  return {
    messageId: parsed.headers['message-id']?.trim() ?? null,
    from: stripAddressName(decodeMimeWords(parsed.headers.from ?? 'unknown')),
    subject: decodeMimeWords(parsed.headers.subject ?? ''),
    text: text && text.length > 0 ? text : '(No plain text body)',
  };
}

export async function stableMessageId(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}
