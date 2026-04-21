/**
 * Card elements for cross-platform rich messaging.
 *
 * Provides a builder API for creating rich cards that automatically
 * convert to platform-specific formats:
 * - Slack: Block Kit
 * - Teams: Adaptive Cards
 * - Google Chat: Card v2
 *
 * Supports both function-call and JSX syntax:
 *
 * @example Function API
 * ```ts
 * import { Card, Text, Actions, Button } from "chat";
 *
 * await thread.post(
 *   Card({
 *     title: "Order #1234",
 *     children: [
 *       Text("Total: $50.00"),
 *       Actions([
 *         Button({ id: "approve", label: "Approve", style: "primary" }),
 *         Button({ id: "reject", label: "Reject", style: "danger" }),
 *       ]),
 *     ],
 *   })
 * );
 * ```
 *
 * @example JSX API (requires jsxImportSource: "chat" in tsconfig)
 * ```tsx
 * /** @jsxImportSource chat *\/
 * import { Card, Text, Actions, Button } from "chat";
 *
 * await thread.post(
 *   <Card title="Order #1234">
 *     <Text>Total: $50.00</Text>
 *     <Actions>
 *       <Button id="approve" style="primary">Approve</Button>
 *       <Button id="reject" style="danger">Reject</Button>
 *     </Actions>
 *   </Card>
 * );
 * ```
 */

/** Button style options */
type ButtonStyle = "primary" | "danger" | "default";
/** Text style options */
type TextStyle = "plain" | "bold" | "muted";
/** Button element for interactive actions */
interface ButtonElement {
    /** If true, the button is displayed in an inactive state and doesn't respond to user actions */
    disabled?: boolean;
    /** Unique action ID for callback routing */
    id: string;
    /** Button label text */
    label: string;
    /** Visual style */
    style?: ButtonStyle;
    type: "button";
    /** Optional payload value sent with action callback */
    value?: string;
}
/** Link button element that opens a URL */
interface LinkButtonElement {
    /** Button label text */
    label: string;
    /** Visual style */
    style?: ButtonStyle;
    type: "link-button";
    /** URL to open when clicked */
    url: string;
}
/** Text content element */
interface TextElement {
    /** Text content (supports markdown in some platforms) */
    content: string;
    /** Text style */
    style?: TextStyle;
    type: "text";
}
/** Image element */
interface ImageElement {
    /** Alt text for accessibility */
    alt?: string;
    type: "image";
    /** Image URL */
    url: string;
}
/** Visual divider/separator */
interface DividerElement {
    type: "divider";
}
/** Container for action buttons and selects */
interface ActionsElement {
    /** Button, link button, select, and radio select elements */
    children: (ButtonElement | LinkButtonElement | SelectElement | RadioSelectElement)[];
    type: "actions";
}
/** Section container for grouping elements */
interface SectionElement {
    /** Section children */
    children: CardChild[];
    type: "section";
}
/** Inline hyperlink element */
interface LinkElement {
    /** Link label text */
    label: string;
    type: "link";
    /** URL to link to */
    url: string;
}
/** Field for key-value display */
interface FieldElement {
    /** Field label */
    label: string;
    type: "field";
    /** Field value */
    value: string;
}
/** Fields container for multi-column layout */
interface FieldsElement {
    /** Field elements */
    children: FieldElement[];
    type: "fields";
}
/** Column alignment for table elements */
type TableAlignment = "left" | "center" | "right";
/** Table element for structured data display */
interface TableElement {
    /** Column alignment */
    align?: TableAlignment[];
    /** Column header labels */
    headers: string[];
    /** Data rows (each row is an array of cell strings) */
    rows: string[][];
    type: "table";
}
/** Union of all card child element types */
type CardChild = TextElement | ImageElement | DividerElement | ActionsElement | SectionElement | FieldsElement | LinkElement | TableElement;
/** Union of all element types (including nested children) */
type AnyCardElement = CardChild | CardElement | ButtonElement | LinkButtonElement | LinkElement | FieldElement | SelectElement | RadioSelectElement;
/** Root card element */
interface CardElement {
    /** Card content */
    children: CardChild[];
    /** Header image URL */
    imageUrl?: string;
    /** Card subtitle */
    subtitle?: string;
    /** Card title */
    title?: string;
    type: "card";
}
/** Type guard for CardElement */
declare function isCardElement(value: unknown): value is CardElement;
/** Options for Card */
interface CardOptions {
    children?: CardChild[];
    imageUrl?: string;
    subtitle?: string;
    title?: string;
}
/**
 * Create a Card element.
 *
 * @example
 * ```ts
 * Card({
 *   title: "Welcome",
 *   children: [Text("Hello!")],
 * })
 * ```
 */
declare function Card(options?: CardOptions): CardElement;
/**
 * Create a Text element.
 *
 * @example
 * ```ts
 * Text("Hello, world!")
 * Text("Important", { style: "bold" })
 * ```
 */
declare function Text(content: string, options?: {
    style?: TextStyle;
}): TextElement;
/**
 * Create an Image element.
 *
 * @example
 * ```ts
 * Image({ url: "https://example.com/image.png", alt: "Description" })
 * ```
 */
declare function Image(options: {
    url: string;
    alt?: string;
}): ImageElement;
/**
 * Create a Divider element.
 *
 * @example
 * ```ts
 * Divider()
 * ```
 */
declare function Divider(): DividerElement;
/**
 * Create a Section container.
 *
 * @example
 * ```ts
 * Section([
 *   Text("Grouped content"),
 *   Image({ url: "..." }),
 * ])
 * ```
 */
declare function Section(children: CardChild[]): SectionElement;
/**
 * Create an Actions container for buttons and selects.
 *
 * @example
 * ```ts
 * Actions([
 *   Button({ id: "ok", label: "OK" }),
 *   Button({ id: "cancel", label: "Cancel" }),
 *   LinkButton({ url: "https://example.com", label: "Learn More" }),
 *   Select({ id: "priority", label: "Priority", options: [...] }),
 *   RadioSelect({ id: "status", label: "Status", options: [...] }),
 * ])
 * ```
 */
declare function Actions(children: (ButtonElement | LinkButtonElement | SelectElement | RadioSelectElement)[]): ActionsElement;
/** Options for Button */
interface ButtonOptions {
    /** If true, the button is displayed in an inactive state and doesn't respond to user actions */
    disabled?: boolean;
    /** Unique action ID for callback routing */
    id: string;
    /** Button label text */
    label: string;
    /** Visual style */
    style?: ButtonStyle;
    /** Optional payload value sent with action callback */
    value?: string;
}
/**
 * Create a Button element.
 *
 * @example
 * ```ts
 * Button({ id: "submit", label: "Submit", style: "primary" })
 * Button({ id: "delete", label: "Delete", style: "danger", value: "item-123" })
 * ```
 */
declare function Button(options: ButtonOptions): ButtonElement;
/** Options for LinkButton */
interface LinkButtonOptions {
    /** Button label text */
    label: string;
    /** Visual style */
    style?: ButtonStyle;
    /** URL to open when clicked */
    url: string;
}
/**
 * Create a LinkButton element that opens a URL when clicked.
 *
 * @example
 * ```ts
 * LinkButton({ url: "https://example.com", label: "View Docs" })
 * LinkButton({ url: "https://example.com", label: "Learn More", style: "primary" })
 * ```
 */
declare function LinkButton(options: LinkButtonOptions): LinkButtonElement;
/**
 * Create a Field element for key-value display.
 *
 * @example
 * ```ts
 * Field({ label: "Status", value: "Active" })
 * ```
 */
declare function Field(options: {
    label: string;
    value: string;
}): FieldElement;
/**
 * Create a Fields container for multi-column layout.
 *
 * @example
 * ```ts
 * Fields([
 *   Field({ label: "Name", value: "John" }),
 *   Field({ label: "Email", value: "john@example.com" }),
 * ])
 * ```
 */
declare function Fields(children: FieldElement[]): FieldsElement;
/** Options for Table */
interface TableOptions {
    /** Column alignment */
    align?: TableAlignment[];
    /** Column header labels */
    headers: string[];
    /** Data rows */
    rows: string[][];
}
/**
 * Create a Table element for structured data display.
 *
 * @example
 * ```ts
 * Table({
 *   headers: ["Name", "Age", "Role"],
 *   rows: [
 *     ["Alice", "30", "Engineer"],
 *     ["Bob", "25", "Designer"],
 *   ],
 * })
 * ```
 */
declare function Table(options: TableOptions): TableElement;
/**
 * Create a CardLink element for inline hyperlinks.
 *
 * @example
 * ```ts
 * CardLink({ url: "https://example.com", label: "Visit Site" })
 * ```
 */
declare function CardLink(options: {
    url: string;
    label: string;
}): LinkElement;
/**
 * Convert a React element tree to a CardElement tree.
 * This allows using React's JSX with our card components.
 *
 * @example
 * ```tsx
 * import React from "react";
 * import { Card, Text, fromReactElement } from "chat";
 *
 * const element = (
 *   <Card title="Hello">
 *     <Text>World</Text>
 *   </Card>
 * );
 *
 * const card = fromReactElement(element);
 * await thread.post(card);
 * ```
 */
declare function fromReactElement(element: unknown): AnyCardElement | null;
/**
 * Generate fallback text from a card child element.
 * Exported so adapter card converters can call it for unknown types.
 */
declare function cardChildToFallbackText(child: CardChild): string | null;

/**
 * Modal elements for form dialogs.
 */

type ModalChild = TextInputElement | SelectElement | RadioSelectElement | TextElement | FieldsElement;
interface ModalElement {
    callbackId: string;
    children: ModalChild[];
    closeLabel?: string;
    notifyOnClose?: boolean;
    /** Arbitrary string passed through the modal lifecycle (e.g., JSON context). */
    privateMetadata?: string;
    submitLabel?: string;
    title: string;
    type: "modal";
}
interface TextInputElement {
    id: string;
    initialValue?: string;
    label: string;
    maxLength?: number;
    multiline?: boolean;
    optional?: boolean;
    placeholder?: string;
    type: "text_input";
}
interface SelectElement {
    id: string;
    initialOption?: string;
    label: string;
    optional?: boolean;
    options: SelectOptionElement[];
    placeholder?: string;
    type: "select";
}
interface SelectOptionElement {
    description?: string;
    label: string;
    value: string;
}
interface RadioSelectElement {
    id: string;
    initialOption?: string;
    label: string;
    optional?: boolean;
    options: SelectOptionElement[];
    type: "radio_select";
}
declare function isModalElement(value: unknown): value is ModalElement;
interface ModalOptions {
    callbackId: string;
    children?: ModalChild[];
    closeLabel?: string;
    notifyOnClose?: boolean;
    /** Arbitrary string passed through the modal lifecycle (e.g., JSON context). */
    privateMetadata?: string;
    submitLabel?: string;
    title: string;
}
declare function Modal(options: ModalOptions): ModalElement;
interface TextInputOptions {
    id: string;
    initialValue?: string;
    label: string;
    maxLength?: number;
    multiline?: boolean;
    optional?: boolean;
    placeholder?: string;
}
declare function TextInput(options: TextInputOptions): TextInputElement;
interface SelectOptions {
    id: string;
    initialOption?: string;
    label: string;
    optional?: boolean;
    options: SelectOptionElement[];
    placeholder?: string;
}
declare function Select(options: SelectOptions): SelectElement;
declare function SelectOption(options: {
    label: string;
    value: string;
    description?: string;
}): SelectOptionElement;
interface RadioSelectOptions {
    id: string;
    initialOption?: string;
    label: string;
    optional?: boolean;
    options: SelectOptionElement[];
}
declare function RadioSelect(options: RadioSelectOptions): RadioSelectElement;
type AnyModalElement = ModalElement | ModalChild | SelectOptionElement;
declare function fromReactModalElement(element: unknown): AnyModalElement | null;

/**
 * Custom JSX runtime for chat cards.
 *
 * This allows using JSX syntax without React. Configure your bundler:
 *
 * tsconfig.json:
 * {
 *   "compilerOptions": {
 *     "jsx": "react-jsx",
 *     "jsxImportSource": "chat"
 *   }
 * }
 *
 * Or per-file:
 * /** @jsxImportSource chat *\/
 *
 * Usage:
 * ```tsx
 * import { Card, Text, Button, Actions } from "chat";
 *
 * const card = (
 *   <Card title="Order #1234">
 *     <Text>Your order is ready!</Text>
 *     <Actions>
 *       <Button id="pickup" style="primary">Schedule Pickup</Button>
 *     </Actions>
 *   </Card>
 * );
 * ```
 */

declare const JSX_ELEMENT: unique symbol;
/** Props for Card component in JSX */
interface CardProps {
    children?: unknown;
    imageUrl?: string;
    subtitle?: string;
    title?: string;
}
/** Props for Text component in JSX */
interface TextProps {
    children?: string | number | (string | number | undefined)[];
    style?: TextStyle;
}
/** Props for Button component in JSX */
interface ButtonProps {
    children?: string | number | (string | number | undefined)[];
    id: string;
    label?: string;
    style?: ButtonStyle;
    value?: string;
}
/** Props for LinkButton component in JSX */
interface LinkButtonProps {
    children?: string | number | (string | number | undefined)[];
    label?: string;
    style?: ButtonStyle;
    url: string;
}
/** Props for CardLink component in JSX */
interface CardLinkProps {
    children?: string | number | (string | number | undefined)[];
    label?: string;
    url: string;
}
/** Props for Image component in JSX */
interface ImageProps {
    alt?: string;
    url: string;
}
/** Props for Field component in JSX */
interface FieldProps {
    label: string;
    value: string;
}
/** Props for container components (Section, Actions, Fields) */
interface ContainerProps {
    children?: unknown;
}
/** Props for Divider component (no props) */
type DividerProps = Record<string, never>;
/** Props for Modal component in JSX */
interface ModalProps {
    callbackId: string;
    children?: unknown;
    closeLabel?: string;
    notifyOnClose?: boolean;
    privateMetadata?: string;
    submitLabel?: string;
    title: string;
}
/** Props for TextInput component in JSX */
interface TextInputProps {
    id: string;
    initialValue?: string;
    label: string;
    maxLength?: number;
    multiline?: boolean;
    optional?: boolean;
    placeholder?: string;
}
/** Props for Select component in JSX */
interface SelectProps {
    children?: unknown;
    id: string;
    initialOption?: string;
    label: string;
    optional?: boolean;
    placeholder?: string;
}
/** Props for SelectOption component in JSX */
interface SelectOptionProps {
    description?: string;
    label: string;
    value: string;
}
/** Props for Table component in JSX */
interface TableProps {
    headers: string[];
    rows: string[][];
}
/** Union of all valid JSX props */
type CardJSXProps = CardProps | TextProps | ButtonProps | LinkButtonProps | CardLinkProps | ImageProps | FieldProps | ContainerProps | DividerProps | ModalProps | TextInputProps | SelectProps | SelectOptionProps | TableProps;
/** Component function type with proper overloads */
type CardComponentFunction = typeof Card | typeof Text | typeof Button | typeof LinkButton | typeof CardLink | typeof Image | typeof Field | typeof Divider | typeof Section | typeof Actions | typeof Fields | typeof Modal | typeof TextInput | typeof Select | typeof RadioSelect | typeof SelectOption | typeof Table;
/**
 * Represents a JSX element from the chat JSX runtime.
 * This is the type returned when using JSX syntax with chat components.
 */
interface CardJSXElement<P extends CardJSXProps = CardJSXProps> {
    $$typeof: typeof JSX_ELEMENT;
    children: unknown[];
    props: P;
    type: CardComponentFunction;
}
/** Union of all element types that can be produced by chat components */
type ChatElement = CardJSXElement | CardElement | TextElement | ButtonElement | LinkButtonElement | LinkElement | ImageElement | DividerElement | ActionsElement | SectionElement | FieldsElement | FieldElement | ModalElement | TextInputElement | SelectElement | SelectOptionElement | RadioSelectElement | TableElement;
interface CardComponent {
    (options?: CardOptions): CardElement;
    (props: CardProps): ChatElement;
}
interface TextComponent {
    (content: string, options?: {
        style?: TextStyle;
    }): TextElement;
    (props: TextProps): ChatElement;
}
interface ButtonComponent {
    (options: ButtonOptions): ButtonElement;
    (props: ButtonProps): ChatElement;
}
interface LinkButtonComponent {
    (options: LinkButtonOptions): LinkButtonElement;
    (props: LinkButtonProps): ChatElement;
}
interface CardLinkComponent {
    (options: {
        url: string;
        label: string;
    }): LinkElement;
    (props: CardLinkProps): ChatElement;
}
interface ImageComponent {
    (options: {
        url: string;
        alt?: string;
    }): ImageElement;
    (props: ImageProps): ChatElement;
}
interface FieldComponent {
    (options: {
        label: string;
        value: string;
    }): FieldElement;
    (props: FieldProps): ChatElement;
}
interface DividerComponent {
    (): DividerElement;
    (props: DividerProps): ChatElement;
}
interface SectionComponent {
    (children: CardChild[]): SectionElement;
    (props: ContainerProps): ChatElement;
}
interface ActionsComponent {
    (children: (ButtonElement | LinkButtonElement | SelectElement | RadioSelectElement)[]): ActionsElement;
    (props: ContainerProps): ChatElement;
}
interface FieldsComponent {
    (children: FieldElement[]): FieldsElement;
    (props: ContainerProps): ChatElement;
}
interface ModalComponent {
    (options: ModalOptions): ModalElement;
    (props: ModalProps): ChatElement;
}
interface TextInputComponent {
    (options: TextInputOptions): TextInputElement;
    (props: TextInputProps): ChatElement;
}
interface SelectComponent {
    (options: SelectOptions): SelectElement;
    (props: SelectProps): ChatElement;
}
interface SelectOptionComponent {
    (options: {
        label: string;
        value: string;
        description?: string;
    }): SelectOptionElement;
    (props: SelectOptionProps): ChatElement;
}
interface RadioSelectComponent {
    (options: RadioSelectOptions): RadioSelectElement;
    (props: SelectProps): ChatElement;
}
interface TableComponent {
    (options: {
        headers: string[];
        rows: string[][];
    }): TableElement;
    (props: TableProps): ChatElement;
}
/**
 * Type guard to check if props match CardLinkProps
 */
declare function isCardLinkProps(props: CardJSXProps): props is CardLinkProps;
/**
 * JSX factory function (used by the JSX transform).
 * Creates a lazy JSX element that will be resolved when needed.
 */
declare function jsx<P extends CardJSXProps>(type: CardComponentFunction, props: P & {
    children?: unknown;
}, _key?: string): CardJSXElement<P>;
/**
 * JSX factory for elements with multiple children.
 */
declare function jsxs<P extends CardJSXProps>(type: CardComponentFunction, props: P & {
    children?: unknown;
}, _key?: string): CardJSXElement<P>;
/**
 * Development JSX factory (same as jsx, but called in dev mode).
 */
declare const jsxDEV: typeof jsx;
/**
 * Fragment support (flattens children).
 */
declare function Fragment(props: {
    children?: unknown;
}): CardChild[];
/**
 * Convert a JSX element tree to a CardElement.
 * Call this on the root JSX element to get a usable CardElement.
 */
declare function toCardElement(jsxElement: unknown): CardElement | null;
declare function toModalElement(jsxElement: unknown): ModalElement | null;
/**
 * Check if a value is a JSX element (from our runtime or React).
 */
declare function isJSX(value: unknown): boolean;
declare namespace JSX {
    type Element = ChatElement;
    type IntrinsicElements = {};
    interface IntrinsicAttributes {
        key?: string | number;
    }
    interface ElementChildrenAttribute {
        children: {};
    }
}

export { type DividerProps as $, type ActionsComponent as A, type ButtonComponent as B, type CardElement as C, type DividerComponent as D, type ImageElement as E, type FieldComponent as F, type LinkButtonElement as G, type LinkButtonOptions as H, type ImageComponent as I, type LinkElement as J, type SectionElement as K, type LinkButtonComponent as L, type ModalElement as M, type TableAlignment as N, type TableElement as O, type TableOptions as P, type TextElement as Q, type RadioSelectComponent as R, type SectionComponent as S, type TextComponent as T, type TextStyle as U, type ButtonProps as V, type CardJSXElement as W, type CardJSXProps as X, type CardLinkProps as Y, type CardProps as Z, type ContainerProps as _, type ChatElement as a, type FieldProps as a0, type ImageProps as a1, type LinkButtonProps as a2, type ModalProps as a3, type SelectOptionProps as a4, type SelectProps as a5, type TextInputProps as a6, type TextProps as a7, type ModalChild as a8, type ModalOptions as a9, type RadioSelectElement as aa, type RadioSelectOptions as ab, type SelectElement as ac, type SelectOptionElement as ad, type SelectOptions as ae, type TextInputElement as af, type TextInputOptions as ag, type TableProps as ah, type TableComponent as ai, isCardLinkProps as aj, jsx as ak, jsxs as al, jsxDEV as am, Fragment as an, JSX as ao, type CardChild as b, type CardComponent as c, cardChildToFallbackText as d, type CardLinkComponent as e, type FieldsComponent as f, fromReactElement as g, isJSX as h, isCardElement as i, Table as j, toModalElement as k, fromReactModalElement as l, isModalElement as m, type ModalComponent as n, type SelectComponent as o, type SelectOptionComponent as p, type TextInputComponent as q, type ActionsElement as r, type ButtonElement as s, toCardElement as t, type ButtonOptions as u, type ButtonStyle as v, type CardOptions as w, type DividerElement as x, type FieldElement as y, type FieldsElement as z };
