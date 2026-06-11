import type { NormalizedClassifierInput } from '@kilocode/auto-routing-contracts';
import type { ClassifierExpectation } from '../grading';

export type ClassifierCase = {
  id: string; // stable slug, e.g. 'impl-low-regex-helper'
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

export const CLASSIFIER_CASES: readonly ClassifierCase[] = [
  // ---------------------------------------------------------------------------
  // implementation (2 low, 2 medium, 2 high)
  // ---------------------------------------------------------------------------
  {
    id: 'impl-low-regex-helper',
    input: chat(
      AGENT_PLAIN_SYSTEM,
      'Write a TypeScript helper function isValidSemver(version: string): boolean that returns true for valid semantic version strings like 1.2.3 and false otherwise. No external dependencies.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'implementation',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'impl-low-add-zod-schema',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Add a Zod schema named PaginationParamsSchema to src/schemas/pagination.ts with optional page (positive int, default 1) and pageSize (positive int, max 100, default 20) fields, and export its inferred type.',
      { messageCount: 3, hasTools: true }
    ),
    expected: {
      taskType: 'implementation',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'impl-medium-rest-endpoint',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Add a new GET /api/projects/:id/members endpoint to our Express router in src/routes/projects.ts. Reuse the existing requireAuth middleware and the ProjectService.getMembers method, and return 404 when the project does not exist.',
      { messageCount: 7, hasTools: true }
    ),
    expected: {
      taskType: 'implementation',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'impl-medium-react-hook',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Implement a useDebouncedValue(value, delayMs) React hook in src/hooks and use it in the SearchBar component so the onSearch callback fires at most once every 300ms. Keep the existing controlled-input behavior.',
      { messageCount: 9, hasTools: true }
    ),
    expected: {
      taskType: 'implementation',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'impl-high-realtime-collab',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Build real-time collaborative editing for our document editor. We have a React frontend, a Node WebSocket gateway, and a Postgres store. Decide and implement a conflict-resolution strategy (OT vs CRDT), wire presence, persistence, and reconnection, and make it consistent across all three layers.',
      { messageCount: 18, hasTools: true }
    ),
    expected: {
      taskType: 'implementation',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },
  {
    id: 'impl-high-rate-limiter',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Implement a distributed sliding-window rate limiter that works across our 4 API replicas backed by Redis. It must handle clock skew between nodes, degrade gracefully if Redis is unavailable, and expose per-tenant limits configured in src/config/limits.ts. Integrate it into the existing middleware chain.',
      { messageCount: 16, hasTools: true }
    ),
    expected: {
      taskType: 'implementation',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },

  // ---------------------------------------------------------------------------
  // debugging (2 low, 2 medium, 2 high)
  // ---------------------------------------------------------------------------
  {
    id: 'debug-low-typo-import',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Running the app throws "TypeError: formatDate is not a function" from src/utils/date.ts line 12. The file exports formatDate as a named export but App.tsx imports it as a default. Fix the import.',
      { messageCount: 4, hasTools: true }
    ),
    expected: {
      taskType: 'debugging',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'debug-low-off-by-one',
    input: chat(
      AGENT_PLAIN_SYSTEM,
      'This pagination function returns one too few items on the last page. Here is the code: `return items.slice(page * size, page * size + size - 1)`. What is wrong and how do I fix it?',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'debugging',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'debug-medium-failing-test',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Our test "UserService > createUser persists the hashed password" started failing after I changed the bcrypt cost factor. The assertion expects a 60-char hash but now gets undefined. Figure out whether the service or the test is wrong and fix it so the suite passes.',
      { messageCount: 8, hasTools: true }
    ),
    expected: {
      taskType: 'debugging',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'debug-medium-cors-error',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Browser requests to our /api/upload endpoint fail with "blocked by CORS policy: No Access-Control-Allow-Origin header". GET requests to other endpoints work fine. The cors middleware is configured in src/server.ts. Find why only upload is affected and fix it.',
      { messageCount: 10, hasTools: true }
    ),
    expected: {
      taskType: 'debugging',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'debug-high-race-condition',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Our payment webhook handler intermittently double-charges customers under load. We use a Postgres advisory lock around the charge, but the duplicate rows have timestamps 2-3ms apart. The handler runs on 3 replicas behind a queue with at-least-once delivery. Investigate the root cause across the worker, queue consumer, and DB layers and fix it.',
      { messageCount: 14, hasTools: true }
    ),
    expected: {
      taskType: 'debugging',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },
  {
    id: 'debug-high-memory-leak',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Our Node service RSS grows by ~50MB/hour in production and OOMs after a day, but it is stable locally. Heap snapshots show growing retained closures referencing our EventEmitter-based cache. It spans the cache module, the websocket session manager, and a third-party metrics client. Trace the leak across these and fix it.',
      { messageCount: 22, hasTools: true }
    ),
    expected: {
      taskType: 'debugging',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },

  // ---------------------------------------------------------------------------
  // refactoring (2 low, 2 medium, 2 high)
  // ---------------------------------------------------------------------------
  {
    id: 'refactor-low-rename-var',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'In src/cart.ts rename the variable `x` to `lineItemTotal` everywhere it is used in the calculateTotal function. No behavior change.',
      { messageCount: 3, hasTools: true }
    ),
    expected: {
      taskType: 'refactoring',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'refactor-low-extract-constant',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'The magic number 86400 appears three times in src/scheduler.ts. Extract it into a named constant SECONDS_PER_DAY at the top of the file and use it in all three places. Keep behavior identical.',
      { messageCount: 2, hasTools: true }
    ),
    expected: {
      taskType: 'refactoring',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'refactor-medium-extract-service',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'The OrderController in src/controllers/order.ts has grown to 400 lines and mixes HTTP handling with business logic. Extract the business logic into an OrderService class, keep the controller thin, and update the existing controller tests to match. Behavior must stay the same.',
      { messageCount: 11, hasTools: true }
    ),
    expected: {
      taskType: 'refactoring',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'refactor-medium-promise-to-async',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Convert the .then()/.catch() promise chains in src/api/client.ts to async/await. There are about six methods. Preserve the existing error-handling semantics and return types exactly.',
      { messageCount: 6, hasTools: true }
    ),
    expected: {
      taskType: 'refactoring',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      executionMode: 'code_change',
      requiresTools: true,
    },
  },
  {
    id: 'refactor-high-modularize-monolith',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Our monolithic src/app.ts wires routing, auth, database access, and background jobs in one 1200-line file with tangled circular imports. Restructure it into clear modules with one-directional dependencies, without changing any external behavior or public routes. Decide the boundaries and migrate incrementally.',
      { messageCount: 26, hasTools: true }
    ),
    expected: {
      taskType: 'refactoring',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },
  {
    id: 'refactor-high-orm-migration',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Migrate our data layer from the legacy hand-written SQL query helpers spread across 30 files to Drizzle ORM, preserving every query result shape and transaction boundary. Plan the sequence so the app keeps passing tests at each step, then carry it out.',
      { messageCount: 30, hasTools: true }
    ),
    expected: {
      taskType: 'refactoring',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },

  // ---------------------------------------------------------------------------
  // planning_design (2 low, 2 medium, 2 high)
  // ---------------------------------------------------------------------------
  {
    id: 'plan-low-naming-choice',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'I have a function that both validates and saves a user. What is a good single name for it, or should I split it? Just give me a recommendation, no code.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'planning_design',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'plan-low-folder-structure',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'For a small Express API with about 8 endpoints, what is a sensible folder structure for routes, controllers, and services? Just describe the layout, do not write code.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'planning_design',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'plan-medium-caching-strategy',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'We have a read-heavy product catalog API hitting Postgres directly. Walk me through the tradeoffs of adding Redis caching vs HTTP cache headers vs a materialized view, and recommend one for a team of three with moderate traffic. No implementation yet.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'planning_design',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'plan-medium-rollout-steps',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'We want to add optimistic UI updates to our existing React + tRPC todo app. Break the work into an ordered implementation plan (state, mutation handling, rollback on error, tests). Just the plan, I will implement it.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'planning_design',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'plan-high-multitenant-architecture',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'Design a multi-tenant architecture for our B2B SaaS. We need tenant isolation, per-tenant data residency (EU vs US), noisy-neighbor protection, and a path to enterprise single-tenant deployments later. Compare schema-per-tenant, row-level, and database-per-tenant, and recommend an approach with its failure modes. Design only.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'planning_design',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'plan-high-event-driven-migration',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'We run a synchronous request/response monolith and want to move order processing to an event-driven design with a message broker. Design the target architecture: event schema/versioning, idempotency, ordering guarantees, dead-letter handling, and how we cut over without downtime. Tradeoffs and a recommended broker, no code.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'planning_design',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },

  // ---------------------------------------------------------------------------
  // investigation (2 low, 2 medium, 2 high)
  // ---------------------------------------------------------------------------
  {
    id: 'invest-low-find-usage',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Where in the codebase is the function getFeatureFlags defined and which files import it? Just tell me, do not change anything.',
      { messageCount: 2, hasTools: true }
    ),
    expected: {
      taskType: 'investigation',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },
  {
    id: 'invest-low-explain-function',
    input: chat(
      AGENT_PLAIN_SYSTEM,
      'Explain what this reducer does, step by step. It handles ADD_ITEM, REMOVE_ITEM, and CLEAR_CART actions. I just want to understand the logic.',
      { messageCount: 1, hasTools: false }
    ),
    expected: {
      taskType: 'investigation',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      executionMode: 'answer_only',
      requiresTools: false,
    },
  },
  {
    id: 'invest-medium-trace-auth-flow',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Explain how a login request flows through our app from the /auth/login route to the session cookie being set. Cover the controller, the AuthService, and the session middleware. I want to understand it before changing anything.',
      { messageCount: 6, hasTools: true }
    ),
    expected: {
      taskType: 'investigation',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },
  {
    id: 'invest-medium-research-sdk',
    input: chat(
      CHAT_ASSISTANT_SYSTEM,
      'Look up the current Stripe Node SDK and summarize how to verify a webhook signature and what the recommended way to handle idempotency keys is. I need to know the current recommended API before I write any code.',
      { messageCount: 1, hasTools: true, latestUserPromptPrefix: null }
    ),
    expected: {
      taskType: 'investigation',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },
  {
    id: 'invest-high-perf-regression-analysis',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Our checkout p95 latency doubled over the last two weeks but no single deploy stands out. Investigate across the API, the database query patterns, the cache hit rates, and the third-party payment calls, and tell me the most likely contributors ranked by evidence. Do not fix anything yet, just analyze.',
      { messageCount: 20, hasTools: true }
    ),
    expected: {
      taskType: 'investigation',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },
  {
    id: 'invest-high-understand-legacy-pipeline',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'We inherited an undocumented data pipeline spanning a cron service, three Lambda functions, an SQS queue, and a Redshift loader. Map out how data flows end to end, what each component assumes about the others, and where the implicit coupling and failure points are. Understanding only, no changes.',
      { messageCount: 24, hasTools: true }
    ),
    expected: {
      taskType: 'investigation',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      executionMode: 'answer_only',
      requiresTools: true,
    },
  },

  // ---------------------------------------------------------------------------
  // agentic_execution (2 low, 2 medium, 2 high)
  // ---------------------------------------------------------------------------
  {
    id: 'agentic-low-run-tests',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Run the test suite with `pnpm test` and tell me if it passes.',
      { messageCount: 2, hasTools: true }
    ),
    expected: {
      taskType: 'agentic_execution',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      executionMode: 'command_execution',
      requiresTools: true,
    },
  },
  {
    id: 'agentic-low-check-git-status',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Run git status and git log --oneline -5 and show me the output so I know what state this checkout is in.',
      { messageCount: 3, hasTools: true }
    ),
    expected: {
      taskType: 'agentic_execution',
      contextComplexity: 'small',
      reasoningComplexity: 'low',
      executionMode: 'command_execution',
      requiresTools: true,
    },
  },
  {
    id: 'agentic-medium-start-dev-server',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Start the local dev environment with `pnpm dev`, wait for it to boot, then curl http://localhost:3000/health and report whether the service and its database connection are healthy.',
      { messageCount: 8, hasTools: true }
    ),
    expected: {
      taskType: 'agentic_execution',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      executionMode: 'command_execution',
      requiresTools: true,
    },
  },
  {
    id: 'agentic-medium-docker-logs',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'The api container keeps restarting. Run docker compose ps, then docker compose logs api --tail 100, identify which command in the logs is failing on boot, and report it back. Just diagnose via the commands, do not edit files.',
      { messageCount: 10, hasTools: true }
    ),
    expected: {
      taskType: 'agentic_execution',
      contextComplexity: 'medium',
      reasoningComplexity: 'medium',
      executionMode: 'command_execution',
      requiresTools: true,
    },
  },
  {
    id: 'agentic-high-release-pipeline',
    input: chat(
      AGENT_TOOLS_SYSTEM,
      'Cut a release: bump the version, run the full build and test suite, build and push the multi-arch Docker image to our registry, tag the git commit, and verify the staging deploy comes up healthy. Stop and report if any step fails.',
      { messageCount: 28, hasTools: true }
    ),
    expected: {
      taskType: 'agentic_execution',
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },
  {
    id: 'agentic-high-recover-broken-env',
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
      contextComplexity: 'large',
      reasoningComplexity: 'high',
      executionMode: 'multi_step_project',
      requiresTools: true,
    },
  },
];
