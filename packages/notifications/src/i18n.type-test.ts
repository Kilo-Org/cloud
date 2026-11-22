import { type PushLocale, resolvePushLocale, translatePush } from './i18n';

// The resolver yields only catalog tags, so a tag no catalog registers cannot be
// compared against its result: the branch is a type error, not a silently false
// one.
// @ts-expect-error 'pt_BR' is not a registered push catalog tag
const compared = resolvePushLocale('es') === 'pt_BR';
void compared;

// The production translator owns its English fallback; a call that omits it
// does not compile.
// @ts-expect-error the fallback argument is required
const missingFallback = translatePush('es', 'generic.title', undefined);
void missingFallback;

// The resolver's result is nameable by a consumer: no `ReturnType` gymnastics.
const named: PushLocale = resolvePushLocale('es');
void named;
// @ts-expect-error 'pt_BR' is not a registered push catalog tag
const bogus: PushLocale = 'pt_BR';
void bogus;
