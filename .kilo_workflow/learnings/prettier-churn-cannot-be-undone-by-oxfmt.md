# Prettier churn cannot be undone by running oxfmt afterwards

**Symptom.** A role agent's diff on its owned files is far larger than the planned
change (thousands of lines across untouched regions): single quotes flipped to double
quotes, object literals rewrapped multi-line. The agent ran Prettier (defaults or its
own config) on repo files.

**Cause.** This repository's formatter is **oxfmt** (root `pnpm format`, config
`.oxfmtrc.json`: `singleQuote`, `printWidth: 100`). Prettier with defaults
(`printWidth: 80`, double quotes) reformats whole files. The trap: running oxfmt
afterwards does NOT restore the original. Prettier expands object literals to one
property per line, and oxfmt (like Prettier) preserves object literals that are
already expanded in the source — so the double-quote churn reverts but the object
expansion stays. Both states are formatter fixed points; the original single-line
form is unrecoverable by formatting.

**Fix.**

- Recovery: `git checkout HEAD -- <files>` and re-apply the functional edits. Do not
  attempt formatter-based repair.
- Prevention (dispatchers): every implementer handoff that touches files pins —
  never run `prettier`/`npx prettier`; the repo formatter is oxfmt
  (`pnpm -w exec oxfmt <file>`); before finishing, run
  `git diff HEAD --stat -- <owned paths>` and confirm the diff is limited to the
  functional edits.
- Detection (orchestrator): compare the emitted slice diff size against the planned
  change size BEFORE dispatching the reviewer. A diff many times larger than the
  plan's edit description is churn — revert and redo the round; do not send churn to
  the reviewer and do not commit it.
