import { getEnvVariable } from '@/lib/dotenvx';
import { writeFile } from 'fs/promises';
import { join } from 'path';

type EventDefinition = {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string;
  is_action: boolean;
  post_to_slack: boolean;
  tags: string[];
};

type PropertyDefinition = {
  id: string;
  name: string;
  is_numerical: boolean;
  property_type: string;
  is_seen_on_filtered_events: boolean;
  tags: string[];
};

type EventDefinitionsResponse = {
  count: number;
  next: string | null;
  previous: string | null;
  results: EventDefinition[];
};

type PropertyDefinitionsResponse = {
  count: number;
  next: string | null;
  previous: string | null;
  results: PropertyDefinition[];
};

type EventWithProperties = EventDefinition & {
  properties: PropertyDefinition[];
};

const POSTHOG_API_BASE = 'https://us.posthog.com';
const PROJECT_ID = '141915';

async function fetchWithAuth(url: string): Promise<Response> {
  const apiKey = getEnvVariable('POSTHOG_PERSONAL_API_KEY');
  if (!apiKey) {
    throw new Error('POSTHOG_PERSONAL_API_KEY environment variable is required');
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText} for ${url}`);
  }

  return response;
}

async function fetchAllEventDefinitions(): Promise<EventDefinition[]> {
  const events: EventDefinition[] = [];
  let nextUrl: string | null = `${POSTHOG_API_BASE}/api/projects/${PROJECT_ID}/event_definitions/`;

  while (nextUrl) {
    console.log(`Fetching event definitions: ${nextUrl}`);
    const response = await fetchWithAuth(nextUrl);
    const data: EventDefinitionsResponse = await response.json();

    events.push(...data.results);
    nextUrl = data.next;

    console.log(
      `  Retrieved ${data.results.length} events (total: ${events.length}/${data.count})`
    );
  }

  return events;
}

async function fetchPropertiesForEvent(eventName: string): Promise<PropertyDefinition[]> {
  const encodedEventName = encodeURIComponent(JSON.stringify([eventName]));
  const url = `${POSTHOG_API_BASE}/api/projects/${PROJECT_ID}/property_definitions?event_names=${encodedEventName}&exclude_core_properties=true&filter_by_event_names=true&is_feature_flag=false`;

  const response = await fetchWithAuth(url);
  const data: PropertyDefinitionsResponse = await response.json();

  return data.results;
}

export async function run(): Promise<void> {
  console.log('🔍 Fetching PostHog event definitions and properties...\n');

  try {
    // Fetch all events
    const events = await fetchAllEventDefinitions();
    console.log(`\n✅ Retrieved ${events.length} total events\n`);

    // Fetch properties for each event
    const eventsWithProperties: EventWithProperties[] = [];
    let processedCount = 0;

    for (const event of events) {
      processedCount++;
      console.log(`[${processedCount}/${events.length}] Fetching properties for: ${event.name}`);

      const properties = await fetchPropertiesForEvent(event.name);
      eventsWithProperties.push({
        ...event,
        properties,
      });

      console.log(`  Found ${properties.length} properties`);
    }

    // Save to file
    const outputPath = join(process.cwd(), 'posthog-event-definitions.json');
    await writeFile(outputPath, JSON.stringify(eventsWithProperties, null, 2), 'utf-8');

    console.log(`\n✅ Complete! Data saved to: ${outputPath}`);
    console.log(`\nSummary:`);
    console.log(`  Total events: ${eventsWithProperties.length}`);
    console.log(
      `  Total properties: ${eventsWithProperties.reduce((sum, e) => sum + e.properties.length, 0)}`
    );

    // Print sample of events with most properties
    console.log(`\nTop 10 events by property count:`);
    const sortedByProperties = [...eventsWithProperties].sort(
      (a, b) => b.properties.length - a.properties.length
    );
    sortedByProperties.slice(0, 10).forEach((event, index) => {
      console.log(`  ${index + 1}. ${event.name} (${event.properties.length} properties)`);
    });
  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  }
}

run().then(console.log, console.error);
