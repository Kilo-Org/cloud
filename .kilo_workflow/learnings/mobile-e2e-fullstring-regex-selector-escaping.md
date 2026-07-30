# mobile e2e: helper patterns are full-string REGEXES — escape parens/dots/plus in literal labels

Symptom: a flow's `waitVisible('Discussion thread src/alpha.ts L10 (RIGHT)')` times out
for 20s while the exact card is on screen; `scrollUntilVisible('Conversation comment at T+2')`
overscrolls to the list bottom; an invariant that tolerates empty `findRects` results then
passes VACUOUSLY.

Cause: `e2e/wdio/helpers.js` `findAll` feeds the pattern to Android UiSelector
`textMatches`/`descriptionMatches` (whole-string Java regex) or the iOS `MATCHES` predicate.
Literal labels containing regex specials silently never match: `(RIGHT)` reads as a group
(missing the literal parens), `.` matches anything, and `T+2` reads as "one or more T then 2".
Worse, `(await findRects(bad))` returns `[]`, so "no X intersects Y" invariants pass with the
target never located.

Fix: in flow files, wrap every literal label in an escaper and assert presence before geometry:

```js
const rx = s => new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
```

A `^...$` anchor is harmless (the driver matches whole strings anyway). When a wait/scroll
times out on something visibly on screen, suspect the pattern before suspecting the app.
