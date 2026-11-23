import {
  NEEDS_INPUT_KINDS,
  needsInputCategoryDescriptors,
  needsInputCategoryId,
  type NeedsInputCategoryId,
} from './needs-input-actions';

// The registry's own output is the widest value the type admits, per kind and PR state.
for (const kind of NEEDS_INPUT_KINDS) {
  const withPr: NeedsInputCategoryId = needsInputCategoryId({ kind, hasPr: true });
  const withoutPr: NeedsInputCategoryId = needsInputCategoryId({ kind, hasPr: false });
  void withPr;
  void withoutPr;
}

// A descriptor's id is the same closed type, so a consumer can rely on it.
const [firstDescriptor] = needsInputCategoryDescriptors();
if (firstDescriptor !== undefined) {
  const id: NeedsInputCategoryId = firstDescriptor.id;
  void id;
}

// The category id is a closed vocabulary, like the action ids beside it: a
// hand-built string is not one of the ids the server may register.
// @ts-expect-error 'kilo-needs-input:bogus' is not a kind the registry emits
const badKind: NeedsInputCategoryId = 'kilo-needs-input:bogus';
void badKind;

const wide: string = 'kilo-needs-input:question';
// @ts-expect-error a plain `string` is not one of the closed category ids
const narrowed: NeedsInputCategoryId = wide;
void narrowed;
