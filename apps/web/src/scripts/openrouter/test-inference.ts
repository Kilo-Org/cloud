import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getAuthToken } from '@/scripts/lib/auth';
import { generateApiToken } from '@/lib/tokens';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';

// Types
type AuthConfig = {
  authToken: string;
  baseUrl: string;
  organizationId: string | null;
};

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  stream_options?: {
    include_usage?: boolean;
  };
};

type ChatCompletionResponse = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

// Constants
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';

// Authentication - same pattern as managed-indexing/test.ts
async function getAuthConfig(organizationId: string): Promise<AuthConfig> {
  console.log('🔑 Generating authentication token...');
  if (z.uuid().safeParse(organizationId).success) {
    console.log(`   Organization ID: ${organizationId}`);
    const authToken = await getAuthToken(organizationId);
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
    console.log('   ✅ Token generated successfully');
    return { authToken, baseUrl, organizationId };
  } else {
    const user = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.google_user_email, organizationId))
      .limit(1);
    if (!user || user.length === 0) {
      throw new Error(`User with email ${organizationId} not found`);
    }

    console.log(`   User Email: ${organizationId}`);
    const authToken = generateApiToken(user[0]);
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
    console.log('   ✅ Token generated successfully');
    return { authToken, baseUrl, organizationId: null };
  }
}

// Make inference call
async function makeInferenceCall(
  baseUrl: string,
  authToken: string,
  model: string,
  prompt: string,
  organizationId: string | null
): Promise<ChatCompletionResponse> {
  const requestBody: ChatCompletionRequest = {
    model,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    stream: false,
    max_tokens: 1024,
  };

  console.log('\n📤 Sending inference request...');
  console.log(`   Model: ${model}`);
  console.log(`   Prompt: "${prompt}"`);
  console.log(`   Base URL: ${baseUrl}`);
  if (organizationId) {
    console.log(`   Organization ID: ${organizationId}`);
  }

  const startTime = Date.now();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
  };

  if (organizationId) {
    headers['X-KiloCode-OrganizationId'] = organizationId;
  }

  const response = await fetch(`${baseUrl}/api/openrouter/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
  });

  const elapsedTime = Date.now() - startTime;

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status} ${response.statusText}`;
    try {
      const errorData = await response.json();
      errorMessage = errorData.error?.message || errorData.error || JSON.stringify(errorData);
    } catch {
      try {
        const errorText = await response.text();
        if (errorText) {
          errorMessage = errorText;
        }
      } catch {
        // Keep the HTTP status message
      }
    }
    throw new Error(`API request failed: ${errorMessage}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  console.log(`   ✅ Response received in ${elapsedTime}ms`);

  return data;
}

// Display results
function displayResults(response: ChatCompletionResponse): void {
  console.log('\n📊 Response Details:');
  console.log(`   ID: ${response.id}`);
  console.log(`   Model: ${response.model}`);
  console.log(`   Finish Reason: ${response.choices[0]?.finish_reason || 'N/A'}`);

  if (response.usage) {
    console.log('\n📈 Token Usage:');
    console.log(`   Prompt Tokens: ${response.usage.prompt_tokens}`);
    console.log(`   Completion Tokens: ${response.usage.completion_tokens}`);
    console.log(`   Total Tokens: ${response.usage.total_tokens}`);
  }

  console.log('\n💬 Assistant Response:');
  console.log('─'.repeat(60));
  const content = response.choices[0]?.message?.content || 'No content';
  console.log(content);
  console.log('─'.repeat(60));
}

/**
 * Test inference script
 * Makes a basic inference call to the OpenRouter API route
 *
 * @param orgId - Organization ID or user email
 * @param model - Model to use (default: anthropic/claude-sonnet-4.5)
 */
export async function run(orgId: string, model: string = DEFAULT_MODEL): Promise<void> {
  if (!orgId) {
    console.error('❌ Error: Organization ID or user email is required');
    console.log(
      '\nUsage: npx tsx src/scripts/index.ts openrouter test-inference <orgId|email> [model]'
    );
    console.log('\nExamples:');
    console.log('  npx tsx src/scripts/index.ts openrouter test-inference user@example.com');
    console.log(
      '  npx tsx src/scripts/index.ts openrouter test-inference <uuid> anthropic/claude-sonnet-4'
    );
    process.exit(1);
  }

  try {
    const { authToken, baseUrl, organizationId } = await getAuthConfig(orgId);

    const prompt = 'Say hello as a pirate. Be brief.';

    const response = await makeInferenceCall(baseUrl, authToken, model, prompt, organizationId);

    displayResults(response);

    console.log('\n✨ Inference test complete!');
  } catch (error) {
    console.error('\n❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
