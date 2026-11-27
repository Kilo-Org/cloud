type XmlNode = { name: string; text: string; children: XmlNode[] };

/** AWS Query XML has a single root and optional namespace. DTDs and external entities are excluded. */
export function createAwsQueryXmlReader(namespace: string, invalid: () => never) {
  function decode(value: string): string {
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(value)) invalid();
    return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_match, name: string) => {
      const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      if (!name.startsWith('#')) return named[name] ?? invalid();
      const code = name.startsWith('#x')
        ? Number.parseInt(name.slice(2), 16)
        : Number(name.slice(1));
      if (
        !Number.isSafeInteger(code) ||
        code > 0x10ffff ||
        (code < 0x20 && ![9, 10, 13].includes(code)) ||
        (code >= 0xd800 && code <= 0xdfff) ||
        code === 0xfffe ||
        code === 0xffff
      )
        invalid();
      return String.fromCodePoint(code);
    });
  }

  function parse(value: string, rootName: string): XmlNode {
    const source = value.replace(/^\s*<\?xml\s+[^?]*\?>/, '');
    const tokens = source.match(/<[^<>]*>|[^<]+/g) ?? [];
    if (tokens.join('') !== source) invalid();
    const document: XmlNode = { name: 'document', text: '', children: [] };
    const stack = [document];
    let count = 0;
    for (const token of tokens) {
      const current = stack.at(-1);
      if (!current) invalid();
      if (!token.startsWith('<')) {
        current.text += decode(token);
        continue;
      }
      const closing = /^<\/([A-Za-z][A-Za-z0-9]*)\s*>$/.exec(token);
      if (closing) {
        if (stack.length < 2 || current.name !== closing[1]) invalid();
        stack.pop();
        continue;
      }
      const opening = /^<([A-Za-z][A-Za-z0-9]*)(?:\s+xmlns="([^"]+)")?\s*(\/?)>$/.exec(token);
      if (!opening || ++count > 10_000 || stack.length >= 32) invalid();
      if (opening[2] !== undefined && (stack.length !== 1 || opening[2] !== namespace)) invalid();
      const node: XmlNode = { name: opening[1], text: '', children: [] };
      current.children.push(node);
      if (!opening[3]) stack.push(node);
    }
    if (stack.length !== 1 || document.text.trim() || document.children.length !== 1) invalid();
    const root = document.children[0];
    if (root.name !== rootName) invalid();
    return root;
  }

  function child(node: XmlNode, name: string): XmlNode | undefined {
    const found = node.children.filter(value => value.name === name);
    if (found.length > 1) invalid();
    return found[0];
  }

  function required(node: XmlNode, name: string): XmlNode {
    return child(node, name) ?? invalid();
  }

  function optionalScalar(node: XmlNode, name: string): string | undefined {
    const value = child(node, name);
    if (!value) return undefined;
    if (value.children.length || value.text.length > 16_384) invalid();
    return value.text;
  }

  function scalar(node: XmlNode, name: string): string {
    return optionalScalar(node, name) ?? invalid();
  }

  function items(node: XmlNode, name: string, itemName: 'item' | 'member'): readonly XmlNode[] {
    const container = child(node, name);
    if (!container) return [];
    if (container.text.trim() || container.children.some(item => item.name !== itemName)) invalid();
    return container.children;
  }

  return { parse, child, required, optionalScalar, scalar, items };
}
