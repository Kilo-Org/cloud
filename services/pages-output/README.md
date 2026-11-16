# Pages output shell

The output shell is the Worker that serves the sandboxed iframe in which a
Page's interactive views (anywidget) run. It lives on its own origin,
`https://pages.kilousercontent.com`, apart from Pages, so widget code never
shares an origin with a Pages session.

It holds no credentials and no data. `wrangler.jsonc` has no bindings, no
variables and no secrets, and a test keeps it that way. The Worker is one ES
module with no imports. It serves the frame HTML at each path in the release's
`output_frame_paths` (today `/frame/v2/`) and answers `GET /health`.

## Source

The shell ships inside the Pages release package, as `output/worker.js` and
`output/wrangler.json`. There is one pin for both Workers:
`../pages/source.json`. This folder has no `source.json` of its own, so the
shell and the Pages viewer cannot drift to different releases.

```
../pages/source.json → nteract release pages-<build_id> + sha256 of its archive
  → pnpm run build (../pages/scripts/pinned.mjs: download, check sha256, read archive)
  → compare output/wrangler.json with wrangler.jsonc, check output/worker.js
    against the receipt's output_files
  → dist/worker.js
wrangler.jsonc → wrangler deploy
```

| File | Holds |
|---|---|
| `wrangler.jsonc` | What deploys: the Worker's name, account and custom domain |
| `scripts/build.mjs` | Builds `dist/` from the Pages pin |
| `scripts/shell.mjs` | The checks on the shell: its structural fields and the receipt's digest |

The archive is read by the same code as the Pages build, with the same rules:
regular files only, no links, no `.` or `..` components, no names that differ
only in case, and exactly two files under `output/`. The build compares
`output/wrangler.json` with `wrangler.jsonc` on every field it names (today
`main`, `no_bundle` and `compatibility_date`), checks `output/worker.js`
against the sha256 in the build receipt's `output_files`, and writes only that
module. It fails on any difference, naming the field or file.

## Deployment

Deployed by `deploy-workers.yml`, like the other Workers, as
`nteract-pages-outputs` on the `pages.kilousercontent.com` custom domain.
`workers_dev` is `false`. A merge to `main` that changes this folder or moves
the Pages pin deploys it; a pin move deploys both Workers.

The two Workers deploy separately, so for a short time a new viewer can meet
an old shell, or the reverse. The frame protocol is versioned for that: a
change that breaks it adds a new path, such as `/frame/v3/`, and the shell
keeps serving the previous one for at least one release. The viewer moves to a
new path only in a release whose shell serves it. Deploy the shell before the
viewer that needs it.

To confirm a deploy:

```bash
curl -s https://pages.kilousercontent.com/health
```

It answers `pages-output-v2 <build_id>`. The build id matches the tag in
`../pages/source.json` (`pages-<build_id>`) and the `build` that
`https://pages-dev.kiloapps.io/health` reports.

### Development

From this folder, with Node 22 or newer:

```bash
pnpm install --filter '{.}...'
pnpm run build
pnpm exec wrangler deploy --dry-run
```

```bash
pnpm test
pnpm typecheck
```

`pnpm run build -- --archive FILE` reads a local archive instead of
downloading one; the digest check against the Pages pin still applies.

### Rollback

```bash
pnpm exec wrangler rollback --name nteract-pages-outputs
```

The shell is stateless, so a rollback or a revert of the pin change is the
whole undo. Roll back the shell only to a build that still serves the frame
path the deployed viewer uses.
