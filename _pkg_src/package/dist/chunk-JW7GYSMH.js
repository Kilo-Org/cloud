// src/markdown.ts
import { toString as mdastToString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
function isTextNode(node) {
  return node.type === "text";
}
function isParagraphNode(node) {
  return node.type === "paragraph";
}
function isStrongNode(node) {
  return node.type === "strong";
}
function isEmphasisNode(node) {
  return node.type === "emphasis";
}
function isDeleteNode(node) {
  return node.type === "delete";
}
function isInlineCodeNode(node) {
  return node.type === "inlineCode";
}
function isCodeNode(node) {
  return node.type === "code";
}
function isLinkNode(node) {
  return node.type === "link";
}
function isBlockquoteNode(node) {
  return node.type === "blockquote";
}
function isListNode(node) {
  return node.type === "list";
}
function isListItemNode(node) {
  return node.type === "listItem";
}
function isTableNode(node) {
  return node.type === "table";
}
function isTableRowNode(node) {
  return node.type === "tableRow";
}
function isTableCellNode(node) {
  return node.type === "tableCell";
}
function tableToAscii(node) {
  const rows = [];
  for (const row of node.children) {
    const cells = [];
    for (const cell of row.children) {
      cells.push(mdastToString(cell));
    }
    rows.push(cells);
  }
  if (rows.length === 0) {
    return "";
  }
  const headers = rows[0];
  const dataRows = rows.slice(1);
  return tableElementToAscii(headers, dataRows);
}
function tableElementToAscii(headers, rows) {
  const allRows = [headers, ...rows];
  const colCount = Math.max(...allRows.map((r) => r.length));
  if (colCount === 0) {
    return "";
  }
  const colWidths = Array.from({ length: colCount }, () => 0);
  for (const row of allRows) {
    for (let i = 0; i < colCount; i++) {
      const cellLen = (row[i] || "").length;
      if (cellLen > colWidths[i]) {
        colWidths[i] = cellLen;
      }
    }
  }
  const formatRow = (cells) => Array.from(
    { length: colCount },
    (_, i) => (cells[i] || "").padEnd(colWidths[i])
  ).join(" | ").trimEnd();
  const lines = [];
  lines.push(formatRow(headers));
  lines.push(colWidths.map((w) => "-".repeat(w)).join("-|-"));
  for (const row of rows) {
    lines.push(formatRow(row));
  }
  return lines.join("\n");
}
function getNodeChildren(node) {
  if ("children" in node && Array.isArray(node.children)) {
    return node.children;
  }
  return [];
}
function getNodeValue(node) {
  if ("value" in node && typeof node.value === "string") {
    return node.value;
  }
  return "";
}
function parseMarkdown(markdown) {
  const processor = unified().use(remarkParse).use(remarkGfm);
  return processor.parse(markdown);
}
function stringifyMarkdown(ast, options) {
  const processor = unified().use(remarkStringify, options).use(remarkGfm);
  return processor.stringify(ast);
}
function toPlainText(ast) {
  return mdastToString(ast);
}
function markdownToPlainText(markdown) {
  const ast = parseMarkdown(markdown);
  return mdastToString(ast);
}
function walkAst(node, visitor) {
  if ("children" in node && Array.isArray(node.children)) {
    node.children = node.children.map((child) => {
      const result = visitor(child);
      if (result === null) {
        return null;
      }
      return walkAst(result, visitor);
    }).filter((n) => n !== null);
  }
  return node;
}
function text(value) {
  return { type: "text", value };
}
function strong(children) {
  return { type: "strong", children };
}
function emphasis(children) {
  return { type: "emphasis", children };
}
function strikethrough(children) {
  return { type: "delete", children };
}
function inlineCode(value) {
  return { type: "inlineCode", value };
}
function codeBlock(value, lang) {
  return { type: "code", value, lang };
}
function link(url, children, title) {
  return { type: "link", url, children, title };
}
function blockquote(children) {
  return { type: "blockquote", children };
}
function paragraph(children) {
  return { type: "paragraph", children };
}
function root(children) {
  return { type: "root", children };
}
var BaseFormatConverter = class {
  renderList(node, depth, nodeConverter, unorderedBullet = "-") {
    const indent = "  ".repeat(depth);
    const start = node.start ?? 1;
    const lines = [];
    for (const [i, item] of getNodeChildren(node).entries()) {
      const prefix = node.ordered ? `${start + i}.` : unorderedBullet;
      let isFirstContent = true;
      for (const child of getNodeChildren(item)) {
        if (isListNode(child)) {
          lines.push(
            this.renderList(child, depth + 1, nodeConverter, unorderedBullet)
          );
          continue;
        }
        const text2 = nodeConverter(child);
        if (!text2.trim()) {
          continue;
        }
        if (isFirstContent) {
          lines.push(`${indent}${prefix} ${text2}`);
          isFirstContent = false;
        } else {
          lines.push(`${indent}  ${text2}`);
        }
      }
    }
    return lines.join("\n");
  }
  /**
   * Default fallback for converting an unknown mdast node to text.
   * Recursively converts children if present, otherwise extracts the node value.
   * Adapters should call this in their nodeToX() default case.
   */
  defaultNodeToText(node, nodeConverter) {
    const children = getNodeChildren(node);
    if (children.length > 0) {
      return children.map(nodeConverter).join("");
    }
    return getNodeValue(node);
  }
  /**
   * Template method for implementing fromAst with a node converter.
   * Iterates through AST children and converts each using the provided function.
   * Joins results with double newlines (standard paragraph separation).
   *
   * @param ast - The AST to convert
   * @param nodeConverter - Function to convert each Content node to string
   * @returns Platform-formatted string
   */
  fromAstWithNodeConverter(ast, nodeConverter) {
    const parts = [];
    for (const node of ast.children) {
      parts.push(nodeConverter(node));
    }
    return parts.join("\n\n");
  }
  extractPlainText(platformText) {
    return toPlainText(this.toAst(platformText));
  }
  // Convenience methods for markdown string I/O
  fromMarkdown(markdown) {
    return this.fromAst(parseMarkdown(markdown));
  }
  toMarkdown(platformText) {
    return stringifyMarkdown(this.toAst(platformText));
  }
  /** @deprecated Use extractPlainText instead */
  toPlainText(platformText) {
    return this.extractPlainText(platformText);
  }
  /**
   * Convert a PostableMessage to platform format (text only).
   * - string: passed through as raw text (no conversion)
   * - { raw: string }: passed through as raw text (no conversion)
   * - { markdown: string }: converted from markdown to platform format
   * - { ast: Root }: converted from AST to platform format
   * - { card: CardElement }: returns fallback text (cards should be handled by adapter)
   * - CardElement: returns fallback text (cards should be handled by adapter)
   *
   * Note: For cards, adapters should check for card content first and render
   * them using platform-specific card APIs, using this method only for fallback.
   */
  renderPostable(message) {
    if (typeof message === "string") {
      return message;
    }
    if ("raw" in message) {
      return message.raw;
    }
    if ("markdown" in message) {
      return this.fromMarkdown(message.markdown);
    }
    if ("ast" in message) {
      return this.fromAst(message.ast);
    }
    if ("card" in message) {
      return message.fallbackText || this.cardToFallbackText(message.card);
    }
    if ("type" in message && message.type === "card") {
      return this.cardToFallbackText(message);
    }
    throw new Error("Invalid PostableMessage format");
  }
  /**
   * Generate fallback text from a card element.
   * Override in subclasses for platform-specific formatting.
   */
  cardToFallbackText(card) {
    const parts = [];
    if (card.title) {
      parts.push(`**${card.title}**`);
    }
    if (card.subtitle) {
      parts.push(card.subtitle);
    }
    for (const child of card.children) {
      const text2 = this.cardChildToFallbackText(child);
      if (text2) {
        parts.push(text2);
      }
    }
    return parts.join("\n");
  }
  /**
   * Convert card child element to fallback text.
   */
  cardChildToFallbackText(child) {
    switch (child.type) {
      case "text":
        return child.content;
      case "fields":
        return child.children.map((f) => `**${f.label}**: ${f.value}`).join("\n");
      case "actions":
        return null;
      case "table":
        return tableElementToAscii(child.headers, child.rows);
      case "section":
        return child.children.map((c) => this.cardChildToFallbackText(c)).filter(Boolean).join("\n");
      default:
        return null;
    }
  }
};

// src/cards.ts
function isCardElement(value) {
  return typeof value === "object" && value !== null && "type" in value && value.type === "card";
}
function Card(options = {}) {
  return {
    type: "card",
    title: options.title,
    subtitle: options.subtitle,
    imageUrl: options.imageUrl,
    children: options.children ?? []
  };
}
function Text(content, options = {}) {
  return {
    type: "text",
    content,
    style: options.style
  };
}
var CardText = Text;
function Image(options) {
  return {
    type: "image",
    url: options.url,
    alt: options.alt
  };
}
function Divider() {
  return { type: "divider" };
}
function Section(children) {
  return {
    type: "section",
    children
  };
}
function Actions(children) {
  return {
    type: "actions",
    children
  };
}
function Button(options) {
  return {
    type: "button",
    id: options.id,
    label: options.label,
    style: options.style,
    value: options.value,
    disabled: options.disabled
  };
}
function LinkButton(options) {
  return {
    type: "link-button",
    url: options.url,
    label: options.label,
    style: options.style
  };
}
function Field(options) {
  return {
    type: "field",
    label: options.label,
    value: options.value
  };
}
function Fields(children) {
  return {
    type: "fields",
    children
  };
}
function Table(options) {
  return {
    type: "table",
    headers: options.headers,
    rows: options.rows,
    align: options.align
  };
}
function CardLink(options) {
  return {
    type: "link",
    url: options.url,
    label: options.label
  };
}
function isReactElement(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const maybeElement = value;
  if (typeof maybeElement.$$typeof !== "symbol") {
    return false;
  }
  const symbolStr = maybeElement.$$typeof.toString();
  return symbolStr.includes("react.element") || symbolStr.includes("react.transitional.element");
}
var componentMap = /* @__PURE__ */ new Map([
  [Card, "Card"],
  [Text, "Text"],
  [Image, "Image"],
  [Divider, "Divider"],
  [Section, "Section"],
  [Actions, "Actions"],
  [Button, "Button"],
  [LinkButton, "LinkButton"],
  [CardLink, "CardLink"],
  [Field, "Field"],
  [Fields, "Fields"],
  [Table, "Table"]
]);
function fromReactElement(element) {
  if (!isReactElement(element)) {
    if (isCardElement(element)) {
      return element;
    }
    if (typeof element === "object" && element !== null && "type" in element) {
      return element;
    }
    return null;
  }
  const { type, props } = element;
  const componentName = componentMap.get(type);
  if (!componentName) {
    if (typeof type === "string") {
      throw new Error(
        `HTML element <${type}> is not supported in card elements. Use Card, Text, Section, Actions, Button, Fields, Field, Image, or Divider components instead.`
      );
    }
    if (props.children) {
      return convertChildren(props.children)[0] ?? null;
    }
    return null;
  }
  const convertedChildren = props.children ? convertChildren(props.children) : [];
  const isCardChild = (el) => el.type !== "card" && el.type !== "button" && el.type !== "link-button" && el.type !== "field" && el.type !== "select" && el.type !== "radio_select";
  switch (componentName) {
    case "Card":
      return Card({
        title: props.title,
        subtitle: props.subtitle,
        imageUrl: props.imageUrl,
        children: convertedChildren.filter(isCardChild)
      });
    case "Text": {
      const content = extractTextContent(props.children);
      return Text(content, { style: props.style });
    }
    case "Image":
      return Image({
        url: props.url,
        alt: props.alt
      });
    case "Divider":
      return Divider();
    case "Section":
      return Section(convertedChildren.filter(isCardChild));
    case "Actions":
      return Actions(
        convertedChildren.filter(
          (c) => c.type === "button" || c.type === "link-button" || c.type === "select" || c.type === "radio_select"
        )
      );
    case "Button": {
      const label = extractTextContent(props.children);
      return Button({
        id: props.id,
        label: props.label ?? label,
        style: props.style,
        value: props.value
      });
    }
    case "LinkButton": {
      const label = extractTextContent(props.children);
      return LinkButton({
        url: props.url,
        label: props.label ?? label,
        style: props.style
      });
    }
    case "CardLink": {
      const label = extractTextContent(props.children);
      return CardLink({
        url: props.url,
        label: props.label ?? label
      });
    }
    case "Field":
      return Field({
        label: props.label,
        value: props.value
      });
    case "Fields":
      return Fields(
        convertedChildren.filter((c) => c.type === "field")
      );
    case "Table":
      return Table({
        headers: props.headers,
        rows: props.rows,
        align: props.align
      });
    default:
      return null;
  }
}
function convertChildren(children) {
  if (children == null) {
    return [];
  }
  if (Array.isArray(children)) {
    return children.flatMap(convertChildren);
  }
  const converted = fromReactElement(children);
  if (converted && typeof converted === "object" && "type" in converted) {
    if (converted.type === "card") {
      return converted.children;
    }
    return [converted];
  }
  return [];
}
function extractTextContent(children) {
  if (typeof children === "string") {
    return children;
  }
  if (typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map(extractTextContent).join("");
  }
  return "";
}
function cardToFallbackText(card) {
  const parts = [];
  if (card.title) {
    parts.push(`**${card.title}**`);
  }
  if (card.subtitle) {
    parts.push(card.subtitle);
  }
  for (const child of card.children) {
    const text2 = cardChildToFallbackText(child);
    if (text2) {
      parts.push(text2);
    }
  }
  return parts.join("\n");
}
function cardChildToFallbackText(child) {
  switch (child.type) {
    case "text":
      return child.content;
    case "link":
      return `${child.label} (${child.url})`;
    case "fields":
      return child.children.map((f) => `${f.label}: ${f.value}`).join("\n");
    case "actions":
      return null;
    case "table":
      return tableElementToAscii(child.headers, child.rows);
    case "section":
      return child.children.map((c) => cardChildToFallbackText(c)).filter(Boolean).join("\n");
    default:
      return null;
  }
}

// src/modals.ts
var VALID_MODAL_CHILD_TYPES = [
  "text_input",
  "select",
  "radio_select",
  "text",
  "fields"
];
function isModalElement(value) {
  return typeof value === "object" && value !== null && "type" in value && value.type === "modal";
}
function filterModalChildren(children) {
  const validChildren = children.filter(
    (c) => typeof c === "object" && c !== null && "type" in c && VALID_MODAL_CHILD_TYPES.includes(
      c.type
    )
  );
  if (validChildren.length < children.length) {
    console.warn(
      "[chat] Modal contains unsupported child elements that were ignored"
    );
  }
  return validChildren;
}
function Modal(options) {
  return {
    type: "modal",
    callbackId: options.callbackId,
    title: options.title,
    submitLabel: options.submitLabel,
    closeLabel: options.closeLabel,
    notifyOnClose: options.notifyOnClose,
    privateMetadata: options.privateMetadata,
    children: options.children ?? []
  };
}
function TextInput(options) {
  return {
    type: "text_input",
    id: options.id,
    label: options.label,
    placeholder: options.placeholder,
    initialValue: options.initialValue,
    multiline: options.multiline,
    optional: options.optional,
    maxLength: options.maxLength
  };
}
function Select(options) {
  if (!options.options || options.options.length === 0) {
    throw new Error("Select requires at least one option");
  }
  return {
    type: "select",
    id: options.id,
    label: options.label,
    placeholder: options.placeholder,
    options: options.options,
    initialOption: options.initialOption,
    optional: options.optional
  };
}
function SelectOption(options) {
  return {
    label: options.label,
    value: options.value,
    description: options.description
  };
}
function RadioSelect(options) {
  if (!options.options || options.options.length === 0) {
    throw new Error("RadioSelect requires at least one option");
  }
  return {
    type: "radio_select",
    id: options.id,
    label: options.label,
    options: options.options,
    initialOption: options.initialOption,
    optional: options.optional
  };
}
function isReactElement2(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const maybeElement = value;
  if (typeof maybeElement.$$typeof !== "symbol") {
    return false;
  }
  const symbolStr = maybeElement.$$typeof.toString();
  return symbolStr.includes("react.element") || symbolStr.includes("react.transitional.element");
}
var modalComponentMap = /* @__PURE__ */ new Map([
  [Modal, "Modal"],
  [TextInput, "TextInput"],
  [Select, "Select"],
  [RadioSelect, "RadioSelect"],
  [SelectOption, "SelectOption"]
]);
function fromReactModalElement(element) {
  if (!isReactElement2(element)) {
    if (isModalElement(element)) {
      return element;
    }
    if (typeof element === "object" && element !== null && "type" in element) {
      return element;
    }
    return null;
  }
  const { type, props } = element;
  const componentName = modalComponentMap.get(type);
  if (!componentName) {
    if (props.children) {
      return convertModalChildren(props.children)[0] ?? null;
    }
    return null;
  }
  const convertedChildren = props.children ? convertModalChildren(props.children) : [];
  switch (componentName) {
    case "Modal":
      return Modal({
        callbackId: props.callbackId,
        title: props.title,
        submitLabel: props.submitLabel,
        closeLabel: props.closeLabel,
        notifyOnClose: props.notifyOnClose,
        privateMetadata: props.privateMetadata,
        children: filterModalChildren(convertedChildren)
      });
    case "TextInput":
      return TextInput({
        id: props.id,
        label: props.label,
        placeholder: props.placeholder,
        initialValue: props.initialValue,
        multiline: props.multiline,
        optional: props.optional,
        maxLength: props.maxLength
      });
    case "Select":
      return Select({
        id: props.id,
        label: props.label,
        placeholder: props.placeholder,
        options: convertedChildren.filter(
          (c) => c !== null && "label" in c && "value" in c && !("type" in c)
        ),
        initialOption: props.initialOption,
        optional: props.optional
      });
    case "RadioSelect":
      return RadioSelect({
        id: props.id,
        label: props.label,
        options: convertedChildren.filter(
          (c) => c !== null && "label" in c && "value" in c && !("type" in c)
        ),
        initialOption: props.initialOption,
        optional: props.optional
      });
    case "SelectOption":
      return SelectOption({
        label: props.label,
        value: props.value,
        description: props.description
      });
    default:
      return null;
  }
}
function convertModalChildren(children) {
  if (children == null) {
    return [];
  }
  if (Array.isArray(children)) {
    return children.flatMap(convertModalChildren);
  }
  const converted = fromReactModalElement(children);
  if (converted) {
    if (isModalElement(converted)) {
      return converted.children;
    }
    return [converted];
  }
  return [];
}

// src/jsx-runtime.ts
var JSX_ELEMENT = /* @__PURE__ */ Symbol.for("chat.jsx.element");
function isJSXElement(value) {
  return typeof value === "object" && value !== null && value.$$typeof === JSX_ELEMENT;
}
function processChildren(children) {
  if (children == null) {
    return [];
  }
  if (Array.isArray(children)) {
    return children.flatMap(processChildren);
  }
  if (isJSXElement(children)) {
    const resolved = resolveJSXElement(children);
    if (resolved) {
      return [resolved];
    }
    return [];
  }
  if (typeof children === "object" && "type" in children) {
    return [children];
  }
  if (typeof children === "string" || typeof children === "number") {
    return [String(children)];
  }
  return [];
}
function isTextProps(props) {
  return !("id" in props || "url" in props || "label" in props);
}
function isButtonProps(props) {
  return "id" in props && typeof props.id === "string" && !("url" in props);
}
function isLinkButtonProps(props) {
  return "url" in props && typeof props.url === "string" && !("id" in props);
}
function isCardLinkProps(props) {
  return "url" in props && typeof props.url === "string" && !("id" in props) && !("alt" in props) && !("style" in props);
}
function isImageProps(props) {
  return "url" in props && typeof props.url === "string";
}
function isFieldProps(props) {
  return "label" in props && "value" in props && typeof props.label === "string" && typeof props.value === "string";
}
function isCardProps(props) {
  return !("id" in props || "url" in props || "callbackId" in props) && ("title" in props || "subtitle" in props || "imageUrl" in props);
}
function isModalProps(props) {
  return "callbackId" in props && "title" in props;
}
function isTextInputProps(props) {
  return "id" in props && "label" in props && !("options" in props) && !("value" in props);
}
function isSelectProps(props) {
  return "id" in props && "label" in props && !("value" in props);
}
function isSelectOptionProps(props) {
  return "label" in props && "value" in props && !("id" in props);
}
function resolveJSXElement(element) {
  const { type, props, children } = element;
  const processedChildren = processChildren(children);
  if (type === Text) {
    const textProps = isTextProps(props) ? props : { style: void 0 };
    const content = processedChildren.length > 0 ? processedChildren.map(String).join("") : String(textProps.children ?? "");
    return Text(content, { style: textProps.style });
  }
  if (type === Section) {
    return Section(processedChildren);
  }
  if (type === Actions) {
    return Actions(
      processedChildren
    );
  }
  if (type === Fields) {
    return Fields(processedChildren);
  }
  if (type === Button) {
    if (!isButtonProps(props)) {
      throw new Error("Button requires an 'id' prop");
    }
    const label = processedChildren.length > 0 ? processedChildren.map(String).join("") : props.label ?? "";
    return Button({
      id: props.id,
      label,
      style: props.style,
      value: props.value
    });
  }
  if (type === LinkButton) {
    if (!isLinkButtonProps(props)) {
      throw new Error("LinkButton requires a 'url' prop");
    }
    const label = processedChildren.length > 0 ? processedChildren.map(String).join("") : props.label ?? "";
    return LinkButton({
      url: props.url,
      label,
      style: props.style
    });
  }
  if (type === CardLink) {
    if (!isCardLinkProps(props)) {
      throw new Error("CardLink requires a 'url' prop");
    }
    const label = processedChildren.length > 0 ? processedChildren.map(String).join("") : props.label ?? "";
    return CardLink({
      url: props.url,
      label
    });
  }
  if (type === Image) {
    if (!isImageProps(props)) {
      throw new Error("Image requires a 'url' prop");
    }
    return Image({ url: props.url, alt: props.alt });
  }
  if (type === Field) {
    if (!isFieldProps(props)) {
      throw new Error("Field requires 'label' and 'value' props");
    }
    return Field({
      label: props.label,
      value: props.value
    });
  }
  if (type === Divider) {
    return Divider();
  }
  if (type === Modal) {
    if (!isModalProps(props)) {
      throw new Error("Modal requires 'callbackId' and 'title' props");
    }
    return Modal({
      callbackId: props.callbackId,
      title: props.title,
      submitLabel: props.submitLabel,
      closeLabel: props.closeLabel,
      notifyOnClose: props.notifyOnClose,
      privateMetadata: props.privateMetadata,
      children: filterModalChildren(processedChildren)
    });
  }
  if (type === TextInput) {
    if (!isTextInputProps(props)) {
      throw new Error("TextInput requires 'id' and 'label' props");
    }
    return TextInput({
      id: props.id,
      label: props.label,
      placeholder: props.placeholder,
      initialValue: props.initialValue,
      multiline: props.multiline,
      optional: props.optional,
      maxLength: props.maxLength
    });
  }
  if (type === Select) {
    if (!isSelectProps(props)) {
      throw new Error("Select requires 'id' and 'label' props");
    }
    return Select({
      id: props.id,
      label: props.label,
      placeholder: props.placeholder,
      initialOption: props.initialOption,
      optional: props.optional,
      options: processedChildren
    });
  }
  if (type === RadioSelect) {
    if (!isSelectProps(props)) {
      throw new Error("RadioSelect requires 'id' and 'label' props");
    }
    return RadioSelect({
      id: props.id,
      label: props.label,
      initialOption: props.initialOption,
      optional: props.optional,
      options: processedChildren
    });
  }
  if (type === SelectOption) {
    if (!isSelectOptionProps(props)) {
      throw new Error("SelectOption requires 'label' and 'value' props");
    }
    return SelectOption({
      label: props.label,
      value: props.value,
      description: props.description
    });
  }
  if (type === Table) {
    const tableProps = props;
    return Table({
      headers: tableProps.headers,
      rows: tableProps.rows
    });
  }
  const cardProps = isCardProps(props) ? props : {};
  return Card({
    title: cardProps.title,
    subtitle: cardProps.subtitle,
    imageUrl: cardProps.imageUrl,
    children: processedChildren
  });
}
function jsx(type, props, _key) {
  const { children, ...restProps } = props;
  return {
    $$typeof: JSX_ELEMENT,
    type,
    props: restProps,
    children: children != null ? [children] : []
  };
}
function jsxs(type, props, _key) {
  const { children, ...restProps } = props;
  let resolvedChildren;
  if (Array.isArray(children)) {
    resolvedChildren = children;
  } else if (children != null) {
    resolvedChildren = [children];
  } else {
    resolvedChildren = [];
  }
  return {
    $$typeof: JSX_ELEMENT,
    type,
    props: restProps,
    children: resolvedChildren
  };
}
var jsxDEV = jsx;
function Fragment(props) {
  return processChildren(props.children);
}
function toCardElement(jsxElement) {
  if (isJSXElement(jsxElement)) {
    const resolved = resolveJSXElement(jsxElement);
    if (resolved && typeof resolved === "object" && "type" in resolved && resolved.type === "card") {
      return resolved;
    }
  }
  if (typeof jsxElement === "object" && jsxElement !== null && "type" in jsxElement && jsxElement.type === "card") {
    return jsxElement;
  }
  return null;
}
function toModalElement(jsxElement) {
  if (isJSXElement(jsxElement)) {
    const resolved = resolveJSXElement(jsxElement);
    if (resolved && typeof resolved === "object" && "type" in resolved && resolved.type === "modal") {
      return resolved;
    }
  }
  if (isModalElement(jsxElement)) {
    return jsxElement;
  }
  return null;
}
function isJSX(value) {
  if (isJSXElement(value)) {
    return true;
  }
  if (typeof value === "object" && value !== null && "$$typeof" in value && typeof value.$$typeof === "symbol") {
    const symbolStr = value.$$typeof.toString();
    return symbolStr.includes("react.element") || symbolStr.includes("react.transitional.element");
  }
  return false;
}

export {
  isTextNode,
  isParagraphNode,
  isStrongNode,
  isEmphasisNode,
  isDeleteNode,
  isInlineCodeNode,
  isCodeNode,
  isLinkNode,
  isBlockquoteNode,
  isListNode,
  isListItemNode,
  isTableNode,
  isTableRowNode,
  isTableCellNode,
  tableToAscii,
  tableElementToAscii,
  getNodeChildren,
  getNodeValue,
  parseMarkdown,
  stringifyMarkdown,
  toPlainText,
  markdownToPlainText,
  walkAst,
  text,
  strong,
  emphasis,
  strikethrough,
  inlineCode,
  codeBlock,
  link,
  blockquote,
  paragraph,
  root,
  BaseFormatConverter,
  isCardElement,
  Card,
  CardText,
  Image,
  Divider,
  Section,
  Actions,
  Button,
  LinkButton,
  Field,
  Fields,
  Table,
  CardLink,
  fromReactElement,
  cardToFallbackText,
  cardChildToFallbackText,
  isModalElement,
  Modal,
  TextInput,
  Select,
  SelectOption,
  RadioSelect,
  fromReactModalElement,
  isCardLinkProps,
  jsx,
  jsxs,
  jsxDEV,
  Fragment,
  toCardElement,
  toModalElement,
  isJSX
};
//# sourceMappingURL=chunk-JW7GYSMH.js.map