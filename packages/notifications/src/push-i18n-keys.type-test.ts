// Compile-time assertions, not a runtime test: the package typecheck compiles
// this file, so a `@ts-expect-error` that stops suppressing a real error is a
// TS2578 failure. Nothing here is imported by the package or its tests.
import {
  GENERIC_PUSH_TITLE_KEY,
  SECURITY_FINDING_PUSH_BODY_KEY,
  SECURITY_FINDING_PUSH_TITLE_KEYS,
  type PushCatalogKey,
} from './push-i18n-keys';

// Every exported key constant is a leaf path the English catalog defines.
const genericTitle: PushCatalogKey = GENERIC_PUSH_TITLE_KEY;
const findingBody: PushCatalogKey = SECURITY_FINDING_PUSH_BODY_KEY;

// Each finding kind's section carries its own title line.
const { new_finding, sla_warning, sla_breach } = SECURITY_FINDING_PUSH_TITLE_KEYS;
const findingTitleLines: readonly PushCatalogKey[] = [
  `${new_finding}.title`,
  `${sla_warning}.title`,
  `${sla_breach}.title`,
];

void [genericTitle, findingBody, findingTitleLines];

// The type is closed: a misspelt leaf, a section used as a leaf, and any plain
// string are all rejected, so removing a `satisfies PushCatalogKey` above is not
// a silent miss.
// @ts-expect-error 'generic.titl' is not a key the English catalog defines
const misspelt: PushCatalogKey = 'generic.titl';
// @ts-expect-error 'internal.securityFindingNew' names a section, not a leaf
const section: PushCatalogKey = 'internal.securityFindingNew';
const wide: string = 'generic.title';
// @ts-expect-error a plain `string` is not one of the catalog's leaf paths
const narrowed: PushCatalogKey = wide;
void [misspelt, section, narrowed];
