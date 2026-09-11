---
name: no-comments
description: Keeps code self-explanatory by preventing and removing low-value comments. Use whenever code is written, changed, or reviewed.
---

# No comments

Comments are a last resort. Prefer names, types, structure, and small focused modules that make behavior obvious.

Delete or reject comments that:

- Restate code, types, parameters, or control flow.
- Narrate implementation steps or test setup.
- Serve as banners, separators, history, apologies, or commented-out code.
- Explain confusing local code that should instead be clarified by a small code change.

Keep only comments that preserve information code cannot express:

- Legal or license headers.
- Non-obvious business rules, edge cases, invariants, or security rationale.
- External platform, vendor, dependency, or protocol constraints.
- Public API contracts for external consumers.
- Current issue, specification, ADR, or RFC links explaining a constraint.
- Required formatter, compiler, coverage, generated-file, or lint directives.

During review, flag unnecessary comments and misleading or stale comments. Do not shorten narration into different narration. Remove it or make the code explain itself.
