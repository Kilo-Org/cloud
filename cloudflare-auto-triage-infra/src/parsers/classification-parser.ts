/**
 * ClassificationParser
 *
 * Extracts and validates classification results from Cloud Agent responses.
 * Tries multiple parsing strategies in order of reliability.
 */

import { classificationResultSchema, type ClassificationResult } from '../types';

/**
 * Filter a list of raw label values to only those present in availableLabels
 */
const filterValidLabels = (rawLabels: unknown, availableLabels: string[]): string[] => {
  if (!Array.isArray(rawLabels)) return [];

  return rawLabels.filter((l): l is string => typeof l === 'string' && availableLabels.includes(l));
};

/**
 * Validate a raw parsed object as a ClassificationResult.
 * Injects filtered selectedLabels before running schema validation,
 * so invalid classification values (e.g. "enhancement") are rejected.
 */
const tryParseCandidate = (
  parsed: unknown,
  availableLabels: string[]
): ClassificationResult | null => {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rawLabels = 'selectedLabels' in parsed ? parsed.selectedLabels : undefined;
  const candidate = { ...parsed, selectedLabels: filterValidLabels(rawLabels, availableLabels) };
  const result = classificationResultSchema.safeParse(candidate);
  return result.success ? result.data : null;
};

/**
 * Parse classification from text using multiple strategies
 */
export const parseClassification = (
  text: string,
  availableLabels: string[]
): ClassificationResult => {
  // Strip control characters that might interfere with parsing
  // eslint-disable-next-line no-control-regex
  const cleanText = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  const strategies = [
    { name: 'codeBlock', fn: () => parseFromCodeBlock(cleanText, availableLabels) },
    { name: 'jsonObject', fn: () => parseFromJsonObject(cleanText, availableLabels) },
  ];

  const failures: string[] = [];

  for (const { name, fn } of strategies) {
    try {
      const result = fn();
      if (result) {
        return result;
      }
      failures.push(`${name}: no matching content found`);
    } catch (e) {
      failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Last resort: try parsing from just the tail of the text
  // (classification should always be at the end of the response)
  const tailText = cleanText.slice(-5000);
  try {
    const tailCodeBlockResult = parseFromCodeBlock(tailText, availableLabels);
    if (tailCodeBlockResult) return tailCodeBlockResult;
  } catch {
    // continue
  }
  try {
    const tailJsonResult = parseFromJsonObject(tailText, availableLabels);
    if (tailJsonResult) return tailJsonResult;
  } catch {
    // continue
  }
  failures.push('tailFallback: no matching content in last 5000 chars');

  console.error('[ClassificationParser] All strategies failed', {
    textLength: text.length,
    textPreview: text.slice(0, 500),
    textTail: text.slice(-500),
    failures,
    hasCodeBlock: /```/.test(text),
    hasClassificationKey: /"classification"/.test(text),
  });

  throw new Error('Classification failed — could not parse the agent response. Please retry.');
};

/**
 * Extract classification from markdown code blocks
 * Tries blocks from last to first (most recent)
 */
const parseFromCodeBlock = (
  text: string,
  availableLabels: string[]
): ClassificationResult | null => {
  const codeBlockRegex = /```(?:json|JSON)?\s*\r?\n([\s\S]*?)\r?\n\s*```/g;
  const codeBlocks: string[] = [];
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    codeBlocks.push(match[1]);
  }

  // Try code blocks from last to first (most recent)
  for (let i = codeBlocks.length - 1; i >= 0; i--) {
    try {
      const result = tryParseCandidate(JSON.parse(codeBlocks[i]), availableLabels);
      if (result) return result;
    } catch {
      // Try next block
      continue;
    }
  }

  // Fallback: direct tail search for the last code fence pair.
  // The regex with lazy quantifier can miss the final block in very large texts
  // with many ``` markers, so search backwards from the end instead.
  const lastFenceEnd = text.lastIndexOf('```');
  if (lastFenceEnd !== -1) {
    const searchStart = Math.max(0, lastFenceEnd - 10_000);
    const textSlice = text.substring(searchStart, lastFenceEnd);
    const openFenceIdx = textSlice.lastIndexOf('```');
    if (openFenceIdx !== -1) {
      const fenceContent = textSlice.substring(openFenceIdx);
      // Skip the opening fence line (e.g. "```json\n")
      const contentStart = fenceContent.indexOf('\n');
      if (contentStart !== -1) {
        const jsonContent = fenceContent.substring(contentStart + 1).trim();
        try {
          const result = tryParseCandidate(JSON.parse(jsonContent), availableLabels);
          if (result) return result;
        } catch {
          // Not valid JSON, fall through
        }
      }
    }
  }

  return null;
};

/**
 * Extract classification from plain JSON objects in text
 * Uses balanced brace matching to find JSON objects
 */
const parseFromJsonObject = (
  text: string,
  availableLabels: string[]
): ClassificationResult | null => {
  const jsonObjects = extractJsonObjects(text);

  // Try JSON objects from last to first (most recent)
  for (let i = jsonObjects.length - 1; i >= 0; i--) {
    try {
      const result = tryParseCandidate(JSON.parse(jsonObjects[i]), availableLabels);
      if (result) return result;
    } catch {
      // Try next match
      continue;
    }
  }

  return null;
};

/**
 * Extract JSON objects from text by finding balanced braces
 * This handles nested objects properly
 */
const extractJsonObjects = (text: string): string[] => {
  const objects: string[] = [];
  let depth = 0;
  let startIndex = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      if (depth === 0) {
        startIndex = i;
      }
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && startIndex !== -1) {
        const jsonStr = text.substring(startIndex, i + 1);
        if (looksLikeClassification(jsonStr)) {
          objects.push(jsonStr);
        }
        startIndex = -1;
      }
    }
  }

  return objects;
};

/**
 * Quick check if a JSON string looks like a classification object
 */
const looksLikeClassification = (jsonStr: string): boolean => {
  return (
    jsonStr.includes('"classification"') &&
    jsonStr.includes('"confidence"') &&
    jsonStr.includes('"intentSummary"')
  );
};
