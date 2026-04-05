import { getEnvVariable } from '@/lib/dotenvx';
import { writeFile } from 'fs/promises';
import * as z from 'zod';

const POSTHOG_API_BASE = 'https://us.posthog.com';
const PROJECT_ID = '141915';
const SEARCH_TERM = 'microdollar_usage';
const REPLACEMENT_TERM = 'microdollar_usage_view';
const SEARCH_REGEX = new RegExp(`\\b${SEARCH_TERM}\\b`);

interface PaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

const HogQLQuerySchema = z.object({
  kind: z.literal('HogQLQuery'),
  query: z.string(),
});
const _DataVisualizationNodeSchema = z.object({
  kind: z.literal('DataVisualizationNode'),
  source: z.unknown(),
});

const _DataWarehouseSavedQuerySchema = z.object({
  id: z.string(),
  name: z.string(),
  query: z.union([HogQLQuerySchema, z.null()]),
  latest_history_id: z.string(),
});

const _InsightSchema = z.object({
  id: z.number(),
  short_id: z.string(),
  name: z.string(),
  query: z.unknown(),
});

type DataWarehouseSavedQuery = z.infer<typeof _DataWarehouseSavedQuerySchema>;
type Insight = z.infer<typeof _InsightSchema>;

async function fetchWithAuth(url: string, options?: RequestInit): Promise<Response> {
  // Use dotenvx to get the API key, assuming it's run via `pnpm script` which configures it
  const apiKey = getEnvVariable('POSTHOG_QUERY_WRITER_KEY');
  if (!apiKey) {
    throw new Error('POSTHOG_QUERY_WRITER_KEY environment variable is required');
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${response.statusText} for ${url}\n${errorText}`);
  }

  return response;
}

async function fetchAllPages<T>(initialUrl: string): Promise<T[]> {
  const items: T[] = [];
  let nextUrl: string | null = initialUrl;

  while (nextUrl) {
    console.log(`Fetching: ${nextUrl}`);
    const response = await fetchWithAuth(nextUrl);
    const data: PaginatedResponse<T> = await response.json();

    items.push(...data.results);
    nextUrl = data.next;

    console.log(`  Retrieved ${data.results.length} items (total: ${items.length}/${data.count})`);
  }

  return items;
}

function extractHogQLStrings(query: unknown): string[] {
  const sqlStrings: string[] = [];

  if (!query) return sqlStrings;

  // Try parsing as direct HogQLQuery
  const hogqlResult = HogQLQuerySchema.safeParse(query);
  if (hogqlResult.success) {
    sqlStrings.push(hogqlResult.data.query);
    return sqlStrings;
  }

  // Try parsing as DataVisualizationNode with HogQL source
  const dvnResult = _DataVisualizationNodeSchema.safeParse(query);
  if (dvnResult.success) {
    const sourceResult = HogQLQuerySchema.safeParse(dvnResult.data.source);
    if (sourceResult.success) {
      sqlStrings.push(sourceResult.data.query);
    }
  }

  return sqlStrings;
}

function replaceInQuery(query: unknown): unknown {
  if (!query) return query;

  // Handle direct HogQLQuery
  const hogqlResult = HogQLQuerySchema.safeParse(query);
  if (hogqlResult.success) {
    return {
      ...hogqlResult.data,
      query: hogqlResult.data.query.replace(SEARCH_REGEX, REPLACEMENT_TERM),
    };
  }

  // Handle DataVisualizationNode with HogQL source
  const dvnResult = _DataVisualizationNodeSchema.safeParse(query);
  if (dvnResult.success) {
    const sourceResult = HogQLQuerySchema.safeParse(dvnResult.data.source);
    if (sourceResult.success) {
      return {
        ...dvnResult.data,
        source: {
          ...sourceResult.data,
          query: sourceResult.data.query.replace(SEARCH_REGEX, REPLACEMENT_TERM),
        },
      };
    }
  }

  return query;
}

async function patchView(view: DataWarehouseSavedQuery): Promise<void> {
  if (!view.query) return;

  const updatedQuery = {
    ...view.query,
    query: view.query.query.replace(SEARCH_REGEX, REPLACEMENT_TERM),
  };

  const url = `${POSTHOG_API_BASE}/api/environments/${PROJECT_ID}/warehouse_saved_queries/${view.id}`;
  console.log(`\n🔄 Patching view "${view.name}" (ID: ${view.id})`);
  console.log(`   URL: ${url}`);
  console.log(`   History ID: ${view.latest_history_id}`);
  console.log(`   Old query: ${view.query.query}`);
  console.log(`   New query: ${updatedQuery.query}`);

  const response = await fetchWithAuth(url, {
    method: 'PATCH',
    body: JSON.stringify({
      query: updatedQuery,
      edited_history_id: view.latest_history_id,
    }),
  });

  const result = await response.json();
  console.log(`✅ Successfully patched view "${view.name}"`);
  console.log(`   Response:`, JSON.stringify(result, null, 2));
}

async function patchInsight(insight: Insight): Promise<void> {
  const updatedQuery = replaceInQuery(insight.query);

  const url = `${POSTHOG_API_BASE}/api/environments/${PROJECT_ID}/insights/${insight.id}`;
  console.log(`\n🔄 Patching insight "${insight.name}" (ID: ${insight.id})`);
  console.log(`   URL: ${url}`);
  console.log(`   Old query:`, JSON.stringify(insight.query, null, 2));
  console.log(`   New query:`, JSON.stringify(updatedQuery, null, 2));

  const response = await fetchWithAuth(url, {
    method: 'PATCH',
    body: JSON.stringify({ query: updatedQuery }),
  });

  const result = await response.json();
  console.log(`✅ Successfully patched insight "${insight.name}"`);
  console.log(`   Response:`, JSON.stringify(result, null, 2));
}

// Type guard to avoid "any"
function hasId(x: unknown): x is { id: string | number } {
  return typeof x === 'object' && x !== null && 'id' in x;
}

interface ErrorLog {
  type: 'view' | 'insight';
  name: string;
  id: string | number;
  error: string;
  oldQuery?: string;
  newQuery?: string;
  timestamp: string;
}

// --- Main Logic ---

export async function run(): Promise<void> {
  console.log('🔍 Auditing PostHog for whole-word references to "microdollar_usage"...\n');

  const errorLog: ErrorLog[] = [];

  try {
    // 1. Fetch all Data Warehouse Saved Queries (aka views) via OpenAPI path
    // Spec: /api/environments/{project_id}/warehouse_saved_queries/
    const viewsUrl = `${POSTHOG_API_BASE}/api/environments/${PROJECT_ID}/warehouse_saved_queries/`;
    const views = await fetchAllPages<DataWarehouseSavedQuery>(viewsUrl);
    console.log(`\n✅ Retrieved ${views.length} data warehouse saved queries from: ${viewsUrl}\n`);
    const flaggedViews = views.filter(view => {
      if (view.query?.query) {
        return SEARCH_REGEX.test(view.query.query);
      }
      return false;
    });

    if (flaggedViews.length > 0) {
      console.log(
        `🔴 Found ${flaggedViews.length} Data Warehouse Saved Query(ies) with references:`
      );
      for (const view of flaggedViews) {
        const id = hasId(view) ? String(view.id) : 'unknown';
        console.log(`  - Saved Query: "${view.name}" (ID: ${id})`);
        console.log('    Full object:');
        console.log(JSON.stringify(view, null, 2));
        console.log(`Patching view...`);

        try {
          await patchView(view);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`❌ Failed to patch view "${view.name}":`, errorMessage);
          errorLog.push({
            type: 'view',
            name: view.name,
            id: view.id,
            error: errorMessage,
            oldQuery: view.query?.query,
            newQuery: view.query?.query.replace(SEARCH_REGEX, REPLACEMENT_TERM),
            timestamp: new Date().toISOString(),
          });
          console.log(`⏭️  Skipping to next view...\n`);
        }
      }
    } else {
      console.log(`🟢 No Data Warehouse Saved Queries found with references.`);
    }

    // 2. Fetch all Insights via OpenAPI path
    // Spec: /api/environments/{project_id}/insights/
    const insightsUrl = `${POSTHOG_API_BASE}/api/environments/${PROJECT_ID}/insights/`;
    const insights: Insight[] = await fetchAllPages<Insight>(insightsUrl);
    console.log(`\n✅ Retrieved ${insights.length} insights from: ${insightsUrl}\n`);

    // 4. Audit Insights - extract HogQL and check for search term
    const flaggedInsights = insights.filter(insight => {
      const sqlStrings = extractHogQLStrings(insight.query);
      return sqlStrings.some(sql => SEARCH_REGEX.test(sql));
    });

    if (flaggedInsights.length > 0) {
      console.log(`\n🔴 Found ${flaggedInsights.length} Insight(s) with references:`);
      for (const insight of flaggedInsights) {
        console.log(
          `  - Insight: "${insight.name}" (Short ID: ${insight.short_id}, ID: ${insight.id})`
        );
        console.log('    Full object:');
        console.log(JSON.stringify(insight, null, 2));
        console.log(`Patching insight...`);

        try {
          await patchInsight(insight);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`❌ Failed to patch insight "${insight.name}":`, errorMessage);
          const sqlStrings = extractHogQLStrings(insight.query);
          errorLog.push({
            type: 'insight',
            name: insight.name,
            id: insight.id,
            error: errorMessage,
            oldQuery: sqlStrings.join('\n---\n'),
            newQuery: JSON.stringify(replaceInQuery(insight.query)),
            timestamp: new Date().toISOString(),
          });
          console.log(`⏭️  Skipping to next insight...\n`);
        }
      }
    } else {
      console.log(`\n🟢 No Insights found with references.`);
    }

    const insightsWithSQL = insights.filter(
      insight => extractHogQLStrings(insight.query).length > 0
    );

    // 5b. Report SQL insight statistics
    console.log('\n--- SQL Insight Statistics ---');
    console.log(`Total insights: ${insights.length}`);
    console.log(`Insights with HogQL: ${insightsWithSQL.length}`);
    console.log(
      `Insights without HogQL (non-SQL visualizations): ${insights.length - insightsWithSQL.length}`
    );

    // Write error log to file if there were any errors
    if (errorLog.length > 0) {
      const errorLogPath = 'posthog-patch-errors.json';
      await writeFile(errorLogPath, JSON.stringify(errorLog, null, 2));
      console.log(`\n⚠️  ${errorLog.length} error(s) occurred during patching`);
      console.log(`📝 Error log saved to: ${errorLogPath}`);
    } else {
      console.log('\n✅ All items patched successfully with no errors');
    }
  } catch (error) {
    console.error('❌ Error during audit:', error);
    throw error;
  }
}

run().then(() => console.log('Script finished.'), console.error);
