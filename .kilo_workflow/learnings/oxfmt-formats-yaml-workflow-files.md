# oxfmt formats YAML — workflow files must pass `pnpm format:check` too

Symptom: `pnpm format:check` fails on a newly written GitHub Actions workflow YAML even when the
content was copied verbatim from a reviewed plan whose evidence claimed "oxfmt has no YAML
coverage".

Cause: oxfmt (repo root formatter, 0.40.0) does cover `*.yml`/`*.yaml` — observed 2026-07-28 on
`.github/workflows/extension-store-release.yml`, where it collapsed comment-alignment whitespace
(`contents: write       # comment` → `contents: write # comment`). A plan written against the
"no YAML coverage" assumption produces files that fail the check, and `ci.yml` enforces
format-check on every PR.

Fix: after writing or editing workflow YAML, run `pnpm format` and accept oxfmt's rewrite before
declaring the slice done. Block-scalar (`run: |`) bodies are preserved — including heredoc
indentation — but diff the formatter's output against the intended content before committing so a
future formatter version cannot silently alter load-bearing whitespace.
