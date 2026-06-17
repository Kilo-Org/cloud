import type { NormalizedClassifierInput } from '@kilocode/auto-routing-contracts';
import type { ClassifierExpectation } from '../grading';

export type ClassifierCase = {
  id: string; // stable slug, e.g. 'impl-gen-semver-helper' (<taskType>-<subtype>-<topic>)
  input: NormalizedClassifierInput;
  expected: ClassifierExpectation;
};

const AGENT_TOOLS_SYSTEM =
  'You are Kilo Code, an AI coding assistant operating in an agentic loop with access to read_file, write_file, apply_diff, run_command and search_files tools. Work step by step and verify your changes.';
const AGENT_PLAIN_SYSTEM =
  'You are Kilo Code, an AI coding assistant. You help the user write and modify code in their workspace. Follow the user instructions precisely.';
const CHAT_ASSISTANT_SYSTEM =
  'You are a helpful senior software engineer. Answer the user clearly and concisely. Do not assume access to the user files unless they are pasted in the conversation.';

const HINTS = { provider: null, providerOptions: null } as const;

function chat(
  systemPromptPrefix: string,
  userPromptPrefix: string,
  opts: {
    messageCount: number;
    hasTools: boolean;
    latestUserPromptPrefix?: string | null;
  }
): NormalizedClassifierInput {
  return {
    apiKind: 'chat_completions',
    requestedModel: 'kilo-auto/efficient',
    systemPromptPrefix,
    userPromptPrefix,
    latestUserPromptPrefix: opts.latestUserPromptPrefix ?? null,
    messageCount: opts.messageCount,
    hasTools: opts.hasTools,
    stream: true,
    providerHints: HINTS,
  };
}

// Four cases per (taskType, subtaskType) pair, with difficulty (context and
// reasoning), execution mode, and risk varied within each pair. riskLevel
// follows the taxonomy axis: high = auth/secrets/billing/user-data
// migrations/production routing/destructive ops; medium = changes runtime
// code, service config, or request contracts; low = read-only, test-only,
// docs-only, or isolated reversible code.
export const CLASSIFIER_CASES: readonly ClassifierCase[] = [
  // ---------------------------------------------------------------------------
  // implementation / feature_development
  // ---------------------------------------------------------------------------
  {
    id: 'impl-feat-members-endpoint',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Add a new GET /api/projects/:id/members endpoint to our Express router in src/routes/projects.ts. Reuse the existing requireAuth middleware and the ProjectService.getMembers method, and return 404 when the project does not exist.',
      { messageCount: 7, hasTools: true }
    ),
    expected: {
      taskType: 'implementation',
      subtaskType: 'feature_development',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'medium',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'impl-feat-debounced-search',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Implement a useDebouncedValue(value, delayMs) React hook in src/hooks and use it in the SearchBar component so the onSearch callback fires at most once every 300ms. Keep the existing controlled-input behavior.',
      { messageCount: 9, hasTools: true }
    ),
    expected: {
      taskType: 'implementation',
      subtaskType: 'feature_development',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'medium',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'impl-feat-realtime-collab',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Build real-time collaborative editing for our document editor. We have a React frontend, a Node WebSocket gateway, and a Postgres store. Decide and implement a conflict-resolution strategy (OT vs CRDT), wire presence, persistence, and reconnection, and make it consistent across all three layers.',
      { messageCount: 18, hasTools: true }
    ),
    expected: {
      taskType: 'implementation',
      subtaskType: 'feature_development',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      riskLevel: 'medium',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },
  {
    id: 'impl-feat-rate-limiter',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Implement a distributed sliding-window rate limiter that works across our 4 API replicas backed by Redis. It must handle clock skew between nodes, degrade gracefully if Redis is unavailable, and expose per-tenant limits configured in src/config/limits.ts. Integrate it into the existing middleware chain.',
      { messageCount: 16, hasTools: true }
    ),
    expected: {
      taskType: 'implementation',
      subtaskType: 'feature_development',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      riskLevel: 'medium',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },

  // ---------------------------------------------------------------------------
  // implementation / code_generation
  // ---------------------------------------------------------------------------
  {
    id: 'impl-gen-semver-helper',
    input: chat(
      AGENT_PLAIN_SYSTEM,
      'Write a TypeScript helper function isValidSemver(version: string): boolean that returns true for valid semantic version strings like 1.2.3 and false otherwise. No external dependencies.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'implementation',
      subtaskType: 'code_generation',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'impl-gen-pagination-schema',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Add a Zod schema named PaginationParamsSchema to src/schemas/pagination.ts with optional page (positive int, default 1) and pageSize (positive int, max 100, default 20) fields, and export its inferred type.',
      { messageCount: 3, hasTools: true }
    ),
    expected: {
      taskType: 'implementation',
      subtaskType: 'code_generation',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'impl-gen-api-client',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Generate a typed TypeScript client for our internal REST API from the OpenAPI spec at docs/openapi.yaml: one function per endpoint, a shared fetch wrapper that injects the Authorization header, and response types derived from the spec schemas. Write it to src/generated/api-client.ts; nothing imports it yet, we will wire it in later.',
      { messageCount: 5, hasTools: true }
    ),
    expected: {
      taskType: 'implementation',
      subtaskType: 'code_generation',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'low',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'impl-gen-ci-workflow',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Create a GitHub Actions workflow at .github/workflows/ci.yml that runs pnpm install with caching, then runs typecheck, lint, and test as parallel jobs on every pull request, using Node 22 and pnpm 9.',
      { messageCount: 3, hasTools: true }
    ),
    expected: {
      taskType: 'implementation',
      subtaskType: 'code_generation',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'medium',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },

  // ---------------------------------------------------------------------------
  // implementation / test_creation
  // ---------------------------------------------------------------------------
  {
    id: 'impl-test-slugify-units',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Add Jest unit tests for the slugify function in src/utils/slugify.ts. Cover unicode input, repeated spaces, leading and trailing dashes, and the maxLength option. The function works correctly today, we just have no coverage.',
      { messageCount: 2, hasTools: true }
    ),
    expected: {
      taskType: 'implementation',
      subtaskType: 'test_creation',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'impl-test-checkout-route',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Add supertest integration tests for the POST /api/checkout route: the happy path, an invalid coupon code, and an out-of-stock item. Reuse the existing test app factory in test/helpers/app.ts and the product fixtures. The route itself works fine in production.',
      { messageCount: 7, hasTools: true }
    ),
    expected: {
      taskType: 'implementation',
      subtaskType: 'test_creation',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'low',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'impl-test-e2e-onboarding',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Build a Playwright E2E suite covering signup, email verification, workspace creation, and inviting a teammate, across the web app and the API. Set up seeded test users, per-test database isolation, and wire the suite into CI. Nothing is broken — we have zero end-to-end coverage today and need it before the next launch.',
      { messageCount: 15, hasTools: true }
    ),
    expected: {
      taskType: 'implementation',
      subtaskType: 'test_creation',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      riskLevel: 'low',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },
  {
    id: 'impl-test-pasted-debounce',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'Here is my debounce implementation pasted below. Write a Jest test file for it covering the delay behavior, cancellation, and the immediate=true mode. Just give me the test code, I will add it to the repo myself.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'implementation',
      subtaskType: 'test_creation',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },

  // ---------------------------------------------------------------------------
  // debugging / bug_fixing
  // ---------------------------------------------------------------------------
  {
    id: 'debug-fix-import-mismatch',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Running the app throws "TypeError: formatDate is not a function" from src/utils/date.ts line 12. The file exports formatDate as a named export but App.tsx imports it as a default. Fix the import.',
      { messageCount: 4, hasTools: true }
    ),
    expected: {
      taskType: 'debugging',
      subtaskType: 'bug_fixing',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'debug-fix-pagination-slice',
    input: chat(
      AGENT_PLAIN_SYSTEM,
      'This pagination function returns one too few items on the last page. Here is the code: `return items.slice(page * size, page * size + size - 1)`. What is wrong and how do I fix it?',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'debugging',
      subtaskType: 'bug_fixing',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'debug-fix-cors-upload',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Browser requests to our /api/upload endpoint fail with "blocked by CORS policy: No Access-Control-Allow-Origin header". GET requests to other endpoints work fine. The cors middleware is configured in src/server.ts. Find why only upload is affected and fix it.',
      { messageCount: 10, hasTools: true }
    ),
    expected: {
      taskType: 'debugging',
      subtaskType: 'bug_fixing',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'medium',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'debug-fix-double-charge',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Our payment webhook handler intermittently double-charges customers under load. We use a Postgres advisory lock around the charge, but the duplicate rows have timestamps 2-3ms apart. The handler runs on 3 replicas behind a queue with at-least-once delivery. Investigate the root cause across the worker, queue consumer, and DB layers and fix it.',
      { messageCount: 14, hasTools: true }
    ),
    expected: {
      taskType: 'debugging',
      subtaskType: 'bug_fixing',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      riskLevel: 'high',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },

  // ---------------------------------------------------------------------------
  // debugging / test_repair
  // ---------------------------------------------------------------------------
  {
    id: 'debug-repair-bcrypt-stub',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Our test "UserService > createUser persists the hashed password" fails since we upgraded bcryptjs to v3: the hash comes back undefined because the test still stubs the old callback-style API. The production code is verified working in staging. Update the test stub and assertions so the suite passes.',
      { messageCount: 8, hasTools: true }
    ),
    expected: {
      taskType: 'debugging',
      subtaskType: 'test_repair',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'low',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'debug-repair-aria-snapshots',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'After adding an aria-label to the IconButton component, 14 Jest snapshot tests fail and every diff is just the new attribute. The new markup is intentional and correct. Update the snapshots and fix the one inline assertion in IconButton.test.tsx that checks the rendered props.',
      { messageCount: 5, hasTools: true }
    ),
    expected: {
      taskType: 'debugging',
      subtaskType: 'test_repair',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'debug-repair-flaky-backoff',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'The "retries with exponential backoff" test in src/queue/retry.test.ts is flaky in CI: it asserts real elapsed time around setTimeout and fails when the runners are slow. The production retry logic is correct. Make the test deterministic with vitest fake timers without weakening what it asserts.',
      { messageCount: 9, hasTools: true }
    ),
    expected: {
      taskType: 'debugging',
      subtaskType: 'test_repair',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'low',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'debug-repair-stale-fixtures',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'CI is red: nine tests in services/billing-worker fail with ZodError because the request fixtures still use the old amountCents field that was intentionally renamed to amountMinorUnits last week. The schema change is correct and already deployed. Update the fixtures to match.',
      { messageCount: 6, hasTools: true }
    ),
    expected: {
      taskType: 'debugging',
      subtaskType: 'test_repair',
      contextComplexity: 'medium',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },

  // ---------------------------------------------------------------------------
  // debugging / root_cause_analysis
  // ---------------------------------------------------------------------------
  {
    id: 'debug-rca-sidebar-overflow',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'Why does this sidebar overflow horizontally on mobile only? I pasted the component and its CSS module below; min-width is set on the nav list. Explain the cause — I will fix it myself.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'debugging',
      subtaskType: 'root_cause_analysis',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'debug-rca-local-401',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Requests from our Next.js app to the o11y worker return 401 in local dev, but the same code works in staging. The bearer token is read in apps/web/src/lib/workerClient.ts and validated in the worker auth middleware. Trace where the values diverge and tell me the root cause. Do not change anything yet.',
      { messageCount: 7, hasTools: true }
    ),
    expected: {
      taskType: 'debugging',
      subtaskType: 'root_cause_analysis',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },
  {
    id: 'debug-rca-search-500s',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Roughly 0.5% of requests to /api/search return a 500 with nothing in the application logs. Candidates: the Express handler, the OpenSearch client timeout config, or the nginx proxy in front. Gather evidence from the code and configs and tell me where the failures originate and why. Diagnosis only — I will decide on the fix.',
      { messageCount: 13, hasTools: true }
    ),
    expected: {
      taskType: 'debugging',
      subtaskType: 'root_cause_analysis',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },
  {
    id: 'debug-rca-memory-leak',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Our Node service RSS grows by ~50MB/hour in production and OOMs after a day, but it is stable locally. Heap snapshots show growing retained closures referencing our EventEmitter-based cache. It spans the cache module, the websocket session manager, and a third-party metrics client. Trace the leak across these and report the root cause with the retaining-path evidence. Do not fix anything yet — I want to review the diagnosis with the team first.',
      { messageCount: 22, hasTools: true }
    ),
    expected: {
      taskType: 'debugging',
      subtaskType: 'root_cause_analysis',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },

  // ---------------------------------------------------------------------------
  // refactoring / code_cleanup
  // ---------------------------------------------------------------------------
  {
    id: 'refactor-cleanup-rename-total',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'In src/cart.ts rename the variable `x` to `lineItemTotal` everywhere it is used in the calculateTotal function. No behavior change.',
      { messageCount: 3, hasTools: true }
    ),
    expected: {
      taskType: 'refactoring',
      subtaskType: 'code_cleanup',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'refactor-cleanup-seconds-constant',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'The magic number 86400 appears three times in src/scheduler.ts. Extract it into a named constant SECONDS_PER_DAY at the top of the file and use it in all three places. Keep behavior identical.',
      { messageCount: 2, hasTools: true }
    ),
    expected: {
      taskType: 'refactoring',
      subtaskType: 'code_cleanup',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'refactor-cleanup-shared-pagination',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'src/routes/users.ts and src/routes/orgs.ts each define a parsePagination helper that is character-for-character identical. Move it to src/lib/pagination.ts and import it in both routes. No behavior change.',
      { messageCount: 4, hasTools: true }
    ),
    expected: {
      taskType: 'refactoring',
      subtaskType: 'code_cleanup',
      contextComplexity: 'medium',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'refactor-cleanup-dead-flag',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Remove the dead code paths guarded by ENABLE_OLD_DASHBOARD across src/dashboard/ — the flag has been false in every environment for over a year and the env var was deleted from our deploy configs. Delete the guarded branches, the flag helper, and the now-unused components, keeping everything else identical. Run the test suite when done.',
      { messageCount: 10, hasTools: true }
    ),
    expected: {
      taskType: 'refactoring',
      subtaskType: 'code_cleanup',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'medium',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },

  // ---------------------------------------------------------------------------
  // refactoring / architecture_improvement
  // ---------------------------------------------------------------------------
  {
    id: 'refactor-arch-order-service',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'The OrderController in src/controllers/order.ts has grown to 400 lines and mixes HTTP handling with business logic. Extract the business logic into an OrderService class, keep the controller thin, and update the existing controller tests to match. Behavior must stay the same.',
      { messageCount: 11, hasTools: true }
    ),
    expected: {
      taskType: 'refactoring',
      subtaskType: 'architecture_improvement',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'medium',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'refactor-arch-modular-monolith',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Our monolithic src/app.ts wires routing, auth, database access, and background jobs in one 1200-line file with tangled circular imports. Restructure it into clear modules with one-directional dependencies, without changing any external behavior or public routes. Decide the boundaries and migrate incrementally.',
      { messageCount: 26, hasTools: true }
    ),
    expected: {
      taskType: 'refactoring',
      subtaskType: 'architecture_improvement',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      riskLevel: 'medium',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },
  {
    id: 'refactor-arch-shared-worker-auth',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'The o11y worker and the notifications worker each carry a copy of the same bearer-token auth middleware. Move it into packages/worker-utils as a shared helper and have both workers consume it. Keep the validation behavior identical and keep both workers test suites green.',
      { messageCount: 9, hasTools: true }
    ),
    expected: {
      taskType: 'refactoring',
      subtaskType: 'architecture_improvement',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'medium',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'refactor-arch-repository-layer',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Our tRPC routers import the Drizzle client directly all over the place. Introduce a repository layer: define repository interfaces, implement them for the user and project routers first, update the wiring, and keep every procedure output identical. Set it up so the remaining routers can migrate incrementally.',
      { messageCount: 21, hasTools: true }
    ),
    expected: {
      taskType: 'refactoring',
      subtaskType: 'architecture_improvement',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      riskLevel: 'medium',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },

  // ---------------------------------------------------------------------------
  // refactoring / migration
  // ---------------------------------------------------------------------------
  {
    id: 'refactor-migrate-async-await',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Migrate the .then()/.catch() promise chains in src/api/client.ts to async/await. There are about six methods. Preserve the existing error-handling semantics and return types exactly.',
      { messageCount: 6, hasTools: true }
    ),
    expected: {
      taskType: 'refactoring',
      subtaskType: 'migration',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'medium',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'refactor-migrate-drizzle',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Migrate our data layer from the legacy hand-written SQL query helpers spread across 30 files to Drizzle ORM, preserving every query result shape and transaction boundary. Plan the sequence so the app keeps passing tests at each step, then carry it out.',
      { messageCount: 30, hasTools: true }
    ),
    expected: {
      taskType: 'refactoring',
      subtaskType: 'migration',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      riskLevel: 'medium',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },
  {
    id: 'refactor-migrate-secrets-binding',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Migrate the gastown worker from plaintext vars in wrangler.jsonc to Cloudflare Secrets Store bindings for OPENROUTER_API_KEY and WEBHOOK_SIGNING_SECRET: add the secrets_store_secrets binding, update the env access in the code, and remove the plaintext values. These are live production credentials.',
      { messageCount: 8, hasTools: true }
    ),
    expected: {
      taskType: 'refactoring',
      subtaskType: 'migration',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'high',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'refactor-migrate-oxlint',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Migrate the packages/encryption package from ESLint to oxlint to match the rest of the monorepo: add an .oxlintrc.json extending the root config, switch the lint script in its package.json, and remove the eslint devDependencies.',
      { messageCount: 3, hasTools: true }
    ),
    expected: {
      taskType: 'refactoring',
      subtaskType: 'migration',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },

  // ---------------------------------------------------------------------------
  // planning_design / architecture_design
  // ---------------------------------------------------------------------------
  {
    id: 'plan-arch-express-structure',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'For a small Express API with about 8 endpoints, what is a sensible folder structure for routes, controllers, and services? Just describe the layout, do not write code.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'planning_design',
      subtaskType: 'architecture_design',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'plan-arch-export-responsibility',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'We are adding CSV export to the reporting feature. Should it live in the existing ReportsService, which already handles querying and aggregation, or in a new ExportService? Export adds formatting and async delivery concerns. Recommend where the responsibility belongs and why — no code.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'planning_design',
      subtaskType: 'architecture_design',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'plan-arch-dashboard-state',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'Design the state-management structure for our React dashboard: we have server data via tRPC and React Query, local UI state, and filters that must survive page navigation. Propose which layer owns what (query cache vs a store vs URL params) and where the boundaries between them sit. Design only, I will implement it.',
      { messageCount: 2, hasTools: false }
    ),
    expected: {
      taskType: 'planning_design',
      subtaskType: 'architecture_design',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'plan-arch-cli-plugins',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'Design a plugin architecture for our internal CLI so other teams can ship commands without touching core: the plugin interface, discovery and loading, version compatibility between core and plugins, and which core APIs stay stable. There are about 40 commands today and three teams that want in. Architecture only — no implementation plan needed yet.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'planning_design',
      subtaskType: 'architecture_design',
      contextComplexity: 'medium',
      reasoningComplexity: 'high',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },

  // ---------------------------------------------------------------------------
  // planning_design / technical_planning
  // ---------------------------------------------------------------------------
  {
    id: 'plan-steps-optimistic-ui',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'We want to add optimistic UI updates to our existing React + tRPC todo app. Break the work into an ordered implementation plan (state, mutation handling, rollback on error, tests). Just the plan, I will implement it.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'planning_design',
      subtaskType: 'technical_planning',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'plan-steps-node-upgrade',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'Give me an ordered checklist for upgrading our Express service from Node 20 to Node 22: what to verify beforehand, the upgrade steps, and how to validate after each step. Keep it to the sequence of steps — we already know the runtime differences barely affect our code.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'planning_design',
      subtaskType: 'technical_planning',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'plan-steps-user-module-cutover',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'The target design is already approved: the user module moves from the PHP monolith to the new TypeScript service. Plan the cutover into shippable steps — sequencing, feature flags, data backfill order, verification gates, and rollback points for each step. Plan only, the architecture itself is settled.',
      { messageCount: 3, hasTools: false }
    ),
    expected: {
      taskType: 'planning_design',
      subtaskType: 'technical_planning',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'plan-steps-flaky-ci-triage',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'Our CI is red on about 30% of runs due to flaky tests. Draft a triage plan: how to rank the worst offenders from CI history, a quarantine policy, the order to fix them in, and how to keep new flakes out. Just the plan — no test code.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'planning_design',
      subtaskType: 'technical_planning',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },

  // ---------------------------------------------------------------------------
  // planning_design / system_design
  // ---------------------------------------------------------------------------
  {
    id: 'plan-system-catalog-caching',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'We have a read-heavy product catalog API hitting Postgres directly. Walk me through the tradeoffs of adding Redis caching vs HTTP cache headers vs a materialized view, and recommend one for a team of three with moderate traffic. No implementation yet.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'planning_design',
      subtaskType: 'system_design',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'plan-system-multitenant',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'Design a multi-tenant architecture for our B2B SaaS. We need tenant isolation, per-tenant data residency (EU vs US), noisy-neighbor protection, and a path to enterprise single-tenant deployments later. Compare schema-per-tenant, row-level, and database-per-tenant, and recommend an approach with its failure modes. Design only.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'planning_design',
      subtaskType: 'system_design',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'plan-system-event-driven-orders',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'We run a synchronous request/response monolith and want to move order processing to an event-driven design with a message broker. Design the target architecture: event schema/versioning, idempotency, ordering guarantees, dead-letter handling, and how we cut over without downtime. Tradeoffs and a recommended broker, no code.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'planning_design',
      subtaskType: 'system_design',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'plan-system-webhook-guarantees',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'Design the delivery contract for our outbound webhooks: retry schedule, idempotency keys, payload signing, ordering guarantees, and what we promise customers when their endpoint is down for hours. I want the contract and failure modes nailed down, not code.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'planning_design',
      subtaskType: 'system_design',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },

  // ---------------------------------------------------------------------------
  // investigation / repo_exploration
  // ---------------------------------------------------------------------------
  {
    id: 'invest-repo-feature-flags',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Where in the codebase is the function getFeatureFlags defined and which files import it? Just tell me, do not change anything.',
      { messageCount: 2, hasTools: true }
    ),
    expected: {
      taskType: 'investigation',
      subtaskType: 'repo_exploration',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },
  {
    id: 'invest-repo-secrets-usage',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'List every worker service in this monorepo that uses secrets_store_secrets in its wrangler config, and flag any that still keep plaintext vars. Just report the list with file paths — change nothing.',
      { messageCount: 3, hasTools: true }
    ),
    expected: {
      taskType: 'investigation',
      subtaskType: 'repo_exploration',
      contextComplexity: 'medium',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },
  {
    id: 'invest-repo-kiloclaw-todos',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Find all TODO and FIXME comments under services/kiloclaw and list them with file path and line number. Read-only, do not modify anything.',
      { messageCount: 2, hasTools: true }
    ),
    expected: {
      taskType: 'investigation',
      subtaskType: 'repo_exploration',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },
  {
    id: 'invest-repo-lodash-audit',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Which packages in the monorepo still depend on lodash, and which lodash functions does each one actually import? I am assessing whether we can drop the dependency entirely. Report findings only.',
      { messageCount: 4, hasTools: true }
    ),
    expected: {
      taskType: 'investigation',
      subtaskType: 'repo_exploration',
      contextComplexity: 'large',
      reasoningComplexity: 'medium',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },

  // ---------------------------------------------------------------------------
  // investigation / codebase_understanding
  // ---------------------------------------------------------------------------
  {
    id: 'invest-code-cart-reducer',
    input: chat(
      AGENT_PLAIN_SYSTEM,
      'Explain what this reducer does, step by step. It handles ADD_ITEM, REMOVE_ITEM, and CLEAR_CART actions. I just want to understand the logic.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'investigation',
      subtaskType: 'codebase_understanding',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'invest-code-login-flow',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Explain how a login request flows through our app from the /auth/login route to the session cookie being set. Cover the controller, the AuthService, and the session middleware. I want to understand it before changing anything.',
      { messageCount: 6, hasTools: true }
    ),
    expected: {
      taskType: 'investigation',
      subtaskType: 'codebase_understanding',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },
  {
    id: 'invest-code-checkout-path',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Before we plan any optimization work, walk me through where time goes in our checkout path: the API handler, the database queries it runs, the cache lookups, and the synchronous third-party payment call. Explain which parts block the response and which are deferred. Understanding only — nothing is broken and nothing should change.',
      { messageCount: 12, hasTools: true }
    ),
    expected: {
      taskType: 'investigation',
      subtaskType: 'codebase_understanding',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },
  {
    id: 'invest-code-data-pipeline',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'We inherited an undocumented data pipeline spanning a cron service, three Lambda functions, an SQS queue, and a Redshift loader. Map out how data flows end to end, what each component assumes about the others, and where the implicit coupling and failure points are. Understanding only, no changes.',
      { messageCount: 24, hasTools: true }
    ),
    expected: {
      taskType: 'investigation',
      subtaskType: 'codebase_understanding',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },

  // ---------------------------------------------------------------------------
  // investigation / external_research
  // ---------------------------------------------------------------------------
  {
    id: 'invest-ext-stripe-webhooks',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'Look up the current Stripe Node SDK and summarize how to verify a webhook signature and what the recommended way to handle idempotency keys is. I need to know the current recommended API before I write any code.',
      { messageCount: 1, hasTools: true, latestUserPromptPrefix: null }
    ),
    expected: {
      taskType: 'investigation',
      subtaskType: 'external_research',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },
  {
    id: 'invest-ext-license-check',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'Check the current license of the fast-xml-parser npm package — the package page and its repository — and tell me whether we can use it in a commercial closed-source product. Report what the license actually says today, do not rely on memory.',
      { messageCount: 1, hasTools: true }
    ),
    expected: {
      taskType: 'investigation',
      subtaskType: 'external_research',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },
  {
    id: 'invest-ext-wrangler-secrets',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'Read the current Cloudflare Wrangler docs and summarize how wrangler secret put relates to the newer Secrets Store commands: which command writes where, and what the recommended setup for Workers is today. Current docs only — this changed recently.',
      { messageCount: 2, hasTools: true }
    ),
    expected: {
      taskType: 'investigation',
      subtaskType: 'external_research',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },
  {
    id: 'invest-ext-llm-pricing',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'Research current pricing and rate limits for the frontier model APIs we could route to — OpenRouter plus the major first-party providers — and compare the effective cost per million tokens for our traffic mix of 80% short completions and 20% long-context requests, with prompt caching factored in. Summarize with sources.',
      { messageCount: 1, hasTools: true }
    ),
    expected: {
      taskType: 'investigation',
      subtaskType: 'external_research',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      riskLevel: 'low',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },

  // ---------------------------------------------------------------------------
  // agentic_execution / tool_usage
  // ---------------------------------------------------------------------------
  {
    id: 'agentic-tool-pricing-toggle',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Use the browser tool to open http://localhost:3000/pricing, verify the new annual-billing toggle switches the displayed prices, and take a screenshot of both states. Report what you see — do not change any code.',
      { messageCount: 4, hasTools: true }
    ),
    expected: {
      taskType: 'agentic_execution',
      subtaskType: 'tool_usage',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'command_execution',
      requiresTools: true,
    },
  },
  {
    id: 'agentic-tool-flag-toggle',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Use your HTTP tool to call the staging admin API: enable the newOnboarding feature flag for the qa-team tenant via POST /admin/flags, then GET it back to confirm it took effect. The admin token is in .env.staging.',
      { messageCount: 5, hasTools: true }
    ),
    expected: {
      taskType: 'agentic_execution',
      subtaskType: 'tool_usage',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'medium',
      executionMode: 'command_execution',
      requiresTools: true,
    },
  },
  {
    id: 'agentic-tool-mobile-screenshots',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Open /dashboard, /settings, and /billing in the browser at 375px viewport width and take a screenshot of each. I need them to review the mobile layout — just capture and report, no code changes.',
      { messageCount: 3, hasTools: true }
    ),
    expected: {
      taskType: 'agentic_execution',
      subtaskType: 'tool_usage',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'command_execution',
      requiresTools: true,
    },
  },
  {
    id: 'agentic-tool-signup-walkthrough',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Drive the browser through the signup flow on localhost:3000: fill the form with test+kilo@example.com, submit, enter the dev-mode verification code 000000, and confirm you land on the onboarding screen. Report the outcome of each step with a screenshot at the end.',
      { messageCount: 8, hasTools: true }
    ),
    expected: {
      taskType: 'agentic_execution',
      subtaskType: 'tool_usage',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'low',
      executionMode: 'command_execution',
      requiresTools: true,
    },
  },

  // ---------------------------------------------------------------------------
  // agentic_execution / terminal_operations
  // ---------------------------------------------------------------------------
  {
    id: 'agentic-term-run-tests',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Run the test suite with `pnpm test` and tell me if it passes.',
      {
        messageCount: 2,
        hasTools: true,
      }
    ),
    expected: {
      taskType: 'agentic_execution',
      subtaskType: 'terminal_operations',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'command_execution',
      requiresTools: true,
    },
  },
  {
    id: 'agentic-term-git-state',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Run git status and git log --oneline -5 and show me the output so I know what state this checkout is in.',
      { messageCount: 3, hasTools: true }
    ),
    expected: {
      taskType: 'agentic_execution',
      subtaskType: 'terminal_operations',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      riskLevel: 'low',
      executionMode: 'command_execution',
      requiresTools: true,
    },
  },
  {
    id: 'agentic-term-dev-health',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Start the local dev environment with `pnpm dev`, wait for it to boot, then curl http://localhost:3000/health and report whether the service and its database connection are healthy.',
      { messageCount: 8, hasTools: true }
    ),
    expected: {
      taskType: 'agentic_execution',
      subtaskType: 'terminal_operations',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'low',
      executionMode: 'command_execution',
      requiresTools: true,
    },
  },
  {
    id: 'agentic-term-api-container-logs',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'The api container keeps restarting. Run docker compose ps, then docker compose logs api --tail 100, identify which command in the logs is failing on boot, and report it back. Just diagnose via the commands, do not edit files.',
      { messageCount: 10, hasTools: true }
    ),
    expected: {
      taskType: 'agentic_execution',
      subtaskType: 'terminal_operations',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'low',
      executionMode: 'command_execution',
      requiresTools: true,
    },
  },

  // ---------------------------------------------------------------------------
  // agentic_execution / multi_step_execution
  // ---------------------------------------------------------------------------
  {
    id: 'agentic-multi-cut-release',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Cut a release: bump the version, run the full build and test suite, build and push the multi-arch Docker image to our registry, tag the git commit, and verify the staging deploy comes up healthy. Stop and report if any step fails.',
      { messageCount: 28, hasTools: true }
    ),
    expected: {
      taskType: 'agentic_execution',
      subtaskType: 'multi_step_execution',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      riskLevel: 'high',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },
  {
    id: 'agentic-multi-env-recovery',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'My local environment is broken after a branch switch: migrations are out of sync, node_modules looks stale, and the worker will not start. Diagnose and recover it end to end by running the right commands in order, re-running checks after each fix, until pnpm dev comes up clean. Report what you changed.',
      {
        messageCount: 32,
        hasTools: true,
        latestUserPromptPrefix:
          'Also clear the local cache before reinstalling, I think it is corrupt.',
      }
    ),
    expected: {
      taskType: 'agentic_execution',
      subtaskType: 'multi_step_execution',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      riskLevel: 'low',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },
  {
    id: 'agentic-multi-staging-deploy',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Deploy the notifications worker to staging: run its tests first, then wrangler deploy --env staging, tail the logs for a couple of minutes, hit the staging /health endpoint, and roll back to the previous version if anything looks wrong. Report each step.',
      { messageCount: 11, hasTools: true }
    ),
    expected: {
      taskType: 'agentic_execution',
      subtaskType: 'multi_step_execution',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'medium',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },
  {
    id: 'agentic-multi-prod-backfill',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Run the production backfill for the new display_name column: snapshot the database first, run scripts/backfill-display-name.ts against prod in batches of 1000, verify the updated row count matches the user count, and stop immediately and report if any batch errors. I will be watching — narrate each step.',
      { messageCount: 14, hasTools: true }
    ),
    expected: {
      taskType: 'agentic_execution',
      subtaskType: 'multi_step_execution',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      riskLevel: 'high',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },
];
