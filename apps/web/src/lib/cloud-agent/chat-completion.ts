import { APP_URL } from '@/lib/constants';

// Version string for API requests - must be >= 4.69.1 to pass version check
const FIM_COMPLETION_VERSION = '5.0.0';

// Model to use for FIM completions - using Mistral's Codestral model
const FIM_MODEL = 'mistralai/codestral-latest';

// Maximum tokens for autocomplete suggestions
const FIM_MAX_TOKENS = 100;

type MistralFimResponse = {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    index: number;
    text: string;
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

type GetFimCompletionInput = {
  prefix: string;
  suffix?: string;
  authToken: string;
};

/**
 * Get a FIM (fill-in-the-middle) completion suggestion for autocomplete in the cloud agent chat input.
 * Uses Mistral's FIM endpoint for fast, context-aware completions.
 */
export async function getFimCompletion(input: GetFimCompletionInput): Promise<string> {
  const { prefix, suffix, authToken } = input;

  console.log('[getFimCompletion] called', {
    prefixLength: prefix.length,
    suffixLength: suffix?.length ?? 0,
    prefixPreview: prefix.slice(-50),
  });

  // Don't try to complete very short text
  if (prefix.length < 5) {
    console.log('[getFimCompletion] prefix too short, returning empty');
    return '';
  }

  const headers = new Headers({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
    'X-KiloCode-Version': FIM_COMPLETION_VERSION,
    'User-Agent': `Kilo-Code/${FIM_COMPLETION_VERSION}`,
  });

  let response: Response;
  try {
    response = await fetch(`${APP_URL}/api/fim/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: FIM_MODEL,
        prompt: prefix,
        suffix: suffix || '',
        max_tokens: FIM_MAX_TOKENS,
        stream: false,
      }),
    });
  } catch (error) {
    console.error('[getFimCompletion] fetch failed', { error });
    return '';
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[getFimCompletion] API error:', {
      status: response.status,
      error: errorText.slice(0, 2000),
    });
    return '';
  }

  console.log('[getFimCompletion] API call succeeded');

  let responseBody: MistralFimResponse;
  try {
    responseBody = await response.json();
  } catch (error) {
    console.error('[getFimCompletion] failed to parse response', { error });
    return '';
  }

  const choice = responseBody.choices?.[0];

  if (!choice) {
    console.log('[getFimCompletion] no choice in response');
    return '';
  }

  const suggestion = choice.text || '';
  console.log('[getFimCompletion] raw suggestion', { suggestion: suggestion.slice(0, 100) });

  // Clean up the suggestion
  const cleaned = cleanSuggestion(suggestion);
  console.log('[getFimCompletion] cleaned suggestion', { cleaned: cleaned.slice(0, 100) });
  return cleaned;
}

/**
 * Clean the suggestion by removing unwanted patterns
 */
function cleanSuggestion(suggestion: string): string {
  let cleaned = suggestion;

  // Only take the first line/sentence for brevity
  const firstNewline = cleaned.indexOf('\n');
  if (firstNewline !== -1) {
    cleaned = cleaned.substring(0, firstNewline);
  }

  // Filter out suggestions that are just punctuation or whitespace
  if (cleaned.length < 2 || /^[\s\p{P}]+$/u.test(cleaned)) {
    return '';
  }

  return cleaned;
}
