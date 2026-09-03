# Harness SDK

`@kilocode/harness-sdk` is the SDK that runs a coding agent harness. Read this
file before you change any file in this package.

## Principles

1. Use the strictest TypeScript settings. Do not relax a compiler flag.
2. Use the strictest oxlint and oxfmt settings. Do not add an inline disable.
3. Write a unit test only if it proves behavior. Do not write a test that
   proves the absence of behavior.
4. Performance is a hard requirement. See "Performance" below.
5. Use Effect (`effect`) for the control flow, the errors, and the resources.
6. Make every part pluggable. If a part can be a plugin, make it a plugin.
7. Own the core plugins. The package ships its own default for each plugin
   point.
8. Use a library when a library does the work. Do not write what a dependency
   already gives you.
9. Prove behavior with a local end-to-end run.

## Performance

These are requirements, not goals:

- Use the least CPU.
- Use the least RAM.
- Keep the model cache hit ratio above 95 percent.

A change that adds an allocation on a hot path needs a measurement. A change
that reorders or rewrites the prompt prefix breaks the cache; treat it as a
regression until a measurement says otherwise.

## Rules

- Do not add an abstraction with one implementation, unless it is a declared
  plugin point.
- Do not add a dependency for work that a few lines do.
- Keep the file count low. Put one plugin point in one file.
- Name a file in kebab case. Export a type with `export type`.
- Run `pnpm typecheck && pnpm lint && pnpm test` in this directory before you
  commit.

## Layout

| Path | Purpose |
|---|---|
| `src/index.ts` | The public entry point |
| `.oxlintrc.json` | The package lint config; stricter than the root config |
| `tsconfig.json` | The package compiler config; stricter than the root config |

## Recorded deviations

- `import/no-named-export` is off. This package is a library; a barrel needs
  named exports.
- `import/group-exports` stays on. Declare a name, then export it in one
  `export type { ... }` block and one `export { ... }` block at the end of the
  file.
