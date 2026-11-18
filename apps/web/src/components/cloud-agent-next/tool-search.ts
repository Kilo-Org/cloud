import LinkifyIt from 'linkify-it';
import { toSafeHttpUrl } from '@/lib/safe-http-url';

const httpValidator = new LinkifyIt();
const linkify = new LinkifyIt({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false })
  .add('ftp:', null)
  .add('mailto:', null)
  .add('//', null)
  .add('http:', {
    validate(text, pos) {
      const length = httpValidator.testSchemaAt(text, 'http:', pos);
      if (!text.slice(pos, pos + length).includes('(')) return length;

      let depth = 0;
      const tail = text.slice(pos).match(/^\S*/)?.[0] ?? '';
      const normalized = tail.replace(/[()]/g, parenthesis => {
        if (parenthesis === '(') {
          depth += 1;
          return 'x';
        }
        if (depth === 0) return parenthesis;
        depth -= 1;
        return 'x';
      });
      return httpValidator.testSchemaAt(normalized, 'http:', 0);
    },
  });

export function extractSearchUrls(output?: string): string[] {
  if (!output) return [];
  const urls = new Set<string>();
  for (const match of linkify.match(output.replaceAll('`', ' ')) ?? []) {
    const url = toSafeHttpUrl(match.url.replace(/[.,;:!?]+$/g, ''));
    if (url) urls.add(url);
  }
  return [...urls];
}
