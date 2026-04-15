import { NodeHtmlMarkdown, type TranslatorConfigFactory } from 'node-html-markdown';
import PostalMime, { type Address, type RawEmail } from 'postal-mime';

export type ParsedInboundEmail = {
  messageId: string | null;
  from: string | null;
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

function imageSrcFromNode(node: unknown): string | null {
  if (!node || typeof node !== 'object' || !('getAttribute' in node)) return null;

  const getAttribute = node.getAttribute;
  if (typeof getAttribute !== 'function') return null;

  const src: unknown = Reflect.apply(getAttribute, node, ['src']);
  if (typeof src !== 'string') return null;

  const trimmedSrc = src.trim();
  return trimmedSrc.length > 0 ? trimmedSrc : null;
}

const imageSourceTranslator = (({ node }) => {
  const src = imageSrcFromNode(node);
  return src ? { content: src, recurse: false } : { ignore: true };
}) satisfies TranslatorConfigFactory;

const markdownConverter = new NodeHtmlMarkdown(
  {
    bulletMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
  },
  { img: imageSourceTranslator }
);

markdownConverter.aTagTranslators.set('img', imageSourceTranslator);
markdownConverter.tableCellTranslators.set('img', imageSourceTranslator);

function normalizeText(text: string | undefined, html: string | undefined): string {
  const trimmedText = text?.trim() ?? '';
  if (trimmedText.length > 0) return trimmedText;

  const markdown = html ? markdownConverter.translate(html).replaceAll('\u00a0', ' ').trim() : '';
  return markdown.length > 0 ? markdown : '(No plain text body)';
}

export async function parseRawEmail(raw: RawEmail): Promise<ParsedInboundEmail> {
  const email = await PostalMime.parse(raw);

  return {
    messageId: email.messageId?.trim() ?? null,
    from: firstAddress(email.from),
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
