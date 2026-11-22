import { getNodeValue, parseTree, type Node, type ParseError } from 'jsonc-parser';

type ParsedPlainJson = { ok: true; value: unknown } | { ok: false; error: string };

function findDuplicateKey(node: Node): string | null {
  const stack: Node[] = [node];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    if (current.type === 'object') {
      const seen = new Set<string>();
      for (const property of current.children ?? []) {
        const [key] = property.children ?? [];
        if (!key) continue;
        const name = String(key.value);
        if (seen.has(name)) return name;
        seen.add(name);
        stack.push(...(property.children ?? []).slice(1));
      }
    } else {
      stack.push(...(current.children ?? []));
    }
  }
  return null;
}

export function parsePlainJsonDocument(text: string): ParsedPlainJson {
  if (!text.trim()) return { ok: false, error: 'Enter a JSON policy document.' };
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    disallowComments: true,
    allowTrailingComma: false,
    allowEmptyContent: false,
  });
  if (!root) return { ok: false, error: 'Enter a JSON object.' };
  if (errors.length) {
    const first = errors[0];
    return { ok: false, error: `Invalid JSON near offset ${first.offset}.` };
  }
  if (root.type !== 'object') return { ok: false, error: 'The policy must be a JSON object.' };
  const duplicate = findDuplicateKey(root);
  if (duplicate) return { ok: false, error: `Duplicate key "${duplicate}" is not allowed.` };
  return { ok: true, value: getNodeValue(root) };
}
