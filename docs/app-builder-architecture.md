# App Builder Architecture

This document explains how the App Builder builds, previews, and deploys user
apps. It covers supported frameworks, the deployment pipeline, and common
pitfalls (such as why Vite projects fail to deploy).

## High-level flow

```
User prompt
  -> tRPC router (app-builder-router.ts)
  -> app-builder-service.ts (creates project in Postgres, inits worker)
  -> cloudflare-app-builder worker
       ├── GitRepositoryDO  (stores code as a git repo in DO SQLite)
       └── PreviewDO        (runs a live dev server in a Cloudflare Sandbox)
  -> User clicks "Deploy"
  -> cloudflare-deploy-infra/builder worker
       └── DeploymentOrchestrator DO
             1. Clone repo into a sandbox
             2. Run detect-project.sh
             3. Validate against supportedProjectTypeSchema
             4. Run framework-specific build pipeline
             5. Read artifacts (SandboxArtifactReader)
             6. Deploy as a Cloudflare Worker + Assets
```

## Two distinct phases

### 1. Preview (live dev server)

Handled by `cloudflare-app-builder` — specifically `PreviewDO`
(`cloudflare-app-builder/src/preview-do.ts`).

The preview sandbox is a `cloudflare/sandbox` Docker container that:

1. Clones the project's git repo into `/workspace`.
2. Runs `bun install --frozen-lockfile`.
3. Starts a long-running process via `bun run dev` on port 8080.
4. The preview is served through an iframe proxy that injects a bridge script
   for navigation tracking.

Because the preview runs `bun run dev`, **any framework with a valid `dev`
script in `package.json` will preview correctly** — including Vite, Next.js,
Astro, etc. This is why a Vite + React project appears to "work" in the
preview pane.

### 2. Deployment (production build + Cloudflare Worker)

Handled by `cloudflare-deploy-infra` — specifically `DeploymentOrchestrator`
(`cloudflare-deploy-infra/builder/src/deployment-orchestrator.ts`).

Deployment uses a separate Docker container
(`cloudflare-deploy-infra/builder-docker-container/Dockerfile`) that:

1. Clones the repo into `/workspace/project`.
2. Runs `detect-project.sh` to identify the framework.
3. **Validates the detected type against `supportedProjectTypeSchema`.**
4. Runs the corresponding build pipeline.
5. Reads build artifacts and deploys them as a Cloudflare Worker.

## Supported project types for deployment

The `supportedProjectTypeSchema` is defined in
`cloudflare-deploy-infra/builder/src/types.ts:43-50`:

```typescript
export const supportedProjectTypeSchema = z.enum([
  'nextjs',
  'hugo',
  'jekyll',
  'eleventy',
  'astro',
  'plain-html',
]);
```

Each supported type maps to a build pipeline in `deployment-orchestrator.ts`:

| Project Type | Build Pipeline | Output |
|---|---|---|
| `nextjs` | `install-deps.sh` → `build-nextjs.sh` (OpenNext) → `package-nextjs.sh` | Cloudflare Worker + Assets |
| `astro` | `install-deps.sh` → `build-astro.sh` | `.static-site/assets/` → Static Worker |
| `hugo` | `build-hugo.sh` | `.static-site/assets/` → Static Worker |
| `jekyll` | `build-jekyll.sh` | `.static-site/assets/` → Static Worker |
| `eleventy` | `build-eleventy.sh` | `.static-site/assets/` → Static Worker |
| `plain-html` | `build-static.sh` | `.static-site/assets/` → Static Worker |

All non-Next.js types are deployed as static sites using `static.worker.js`,
a simple Cloudflare Worker that serves files from an `ASSETS` binding with
SPA fallback routing.

## Why Vite fails

### Detection works, but deployment rejects it

The detection script (`detect-project.sh`) *can* identify Vite projects —
it checks for `vite.config.ts/js/mjs` or a `vite` dependency in
`package.json`. It outputs `"vite"` as the project type.

However, the deployment orchestrator then validates the detected type against
`supportedProjectTypeSchema`, and **`"vite"` is not in the schema**. The
deployment fails with:

```
Project type 'vite' is not yet supported
```

This error is thrown at `deployment-orchestrator.ts:555-558`:

```typescript
throw new ProjectDetectionError(
  `Project type '${detectedType}' is not yet supported`,
  detectedType
);
```

### Detection also beats other framework detection

Because Vite detection has **priority 2** in `detect-project.sh` (right after
Next.js), a "Vite + React" project is detected as `"vite"` rather than falling
through to a potentially supported category. The detection order:

1. Next.js (has `next` dependency) — **supported**
2. Vite (has `vite.config.*` or `vite` dependency) — **NOT supported for deploy**
3. Create React App (has `react-scripts`) — **NOT supported for deploy**
4. Vue CLI — NOT supported
5. Angular CLI — NOT supported
6. ... and so on

### The preview misleads

The preview works because it simply runs `bun run dev`. Vite's dev server
starts on port 8080 (via the `PORT` env var) and serves the app correctly.
The user sees a working app in the preview iframe. When they click "Deploy",
the deployment pipeline rejects the project type.

## The gap: detected vs. deployable

`detect-project.sh` detects **15 project types**, but only **6 are
deployable**:

| Detected Type | Deployable? | Notes |
|---|---|---|
| `nextjs` | Yes | Full SSR via OpenNext |
| `vite` | **No** | No build pipeline exists |
| `cra` | **No** | No build pipeline exists |
| `vue-cli` | **No** | No build pipeline exists |
| `angular-cli` | **No** | No build pipeline exists |
| `astro` | Yes | Static-only (SSR mode rejected) |
| `nuxt` | **No** | No build pipeline exists |
| `gatsby` | **No** | No build pipeline exists |
| `remix` | **No** | No build pipeline exists |
| `sveltekit` | **No** | No build pipeline exists |
| `eleventy` | Yes | Static |
| `hugo` | Yes | Static |
| `jekyll` | Yes | Static |
| `generic` | **No** | No build pipeline exists |
| `plain-html` | Yes | Direct file serving |

## Workarounds for users

For a Vite + React app that needs browser APIs (like the Microphone API):

1. **Use Next.js instead.** The default App Builder template is `nextjs-starter`.
   Next.js projects have full deployment support via OpenNext. Client-side
   browser APIs work fine in Next.js client components (`"use client"`).

2. **Use Astro with client-side React islands.** Astro is supported for
   deployment (static mode only). Use `@astrojs/react` for interactive
   components that need browser APIs.

3. **Use plain HTML + JS.** If the app is simple enough, a plain HTML/CSS/JS
   project with `<script>` tags using the browser APIs directly will deploy
   as a `plain-html` static site.

## Deployment output format

All deployed apps run as Cloudflare Workers in a dispatch namespace
(`kilo-deploy`). The deployment produces:

- **Worker script**: Either the OpenNext worker (Next.js) or
  `static.worker.js` (all others)
- **Assets**: Static files uploaded to Cloudflare's asset storage, bound to
  the worker via the `ASSETS` binding
- **Compatibility flags**: `nodejs_compat`, `global_fetch_strictly_public`

The static worker (`cloudflare-deploy-infra/builder/src/assets/static.worker.js`)
provides:
- Direct asset serving
- Clean URL support (`/path` → `/path/index.html`)
- SPA fallback routing (404s on HTML requests serve `index.html`)

## Key file reference

| File | Purpose |
|---|---|
| `cloudflare-app-builder/src/preview-do.ts` | Live preview sandbox management |
| `cloudflare-deploy-infra/builder/src/deployment-orchestrator.ts` | Deployment pipeline orchestration |
| `cloudflare-deploy-infra/builder/src/types.ts` | `supportedProjectTypeSchema` (deploy whitelist) |
| `cloudflare-deploy-infra/builder-docker-container/container-files/detect-project.sh` | Framework detection |
| `cloudflare-deploy-infra/builder/src/sandbox-artifact-reader.ts` | Reads build output for deployment |
| `cloudflare-deploy-infra/builder/src/assets/static.worker.js` | Static site Cloudflare Worker |
| `src/lib/app-builder/app-builder-service.ts` | Backend service (project CRUD, deploy trigger) |
| `src/lib/app-builder/constants.ts` | Templates, system prompts, constraints |
