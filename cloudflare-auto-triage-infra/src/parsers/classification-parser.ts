/**
 * ClassificationParser
 *
 * Extracts and validates classification results from Cloud Agent responses.
 * Tries multiple parsing strategies in order of reliability.
 */

import { type ClassificationResult } from '../types';

/**
 * Filter a list of raw label values to only those present in availableLabels
 */
const filterValidLabels = (rawLabels: unknown, availableLabels: string[]): string[] => {
  console.log('[auto-triage:labels] Filtering selectedLabels from AI output', {
    rawLabels,
    availableLabels,
  });

  if (!Array.isArray(rawLabels)) {
    console.log('[auto-triage:labels] selectedLabels is not an array, returning empty', {
      rawLabels,
    });
    return [];
  }

  const filtered = rawLabels.filter(
    (l): l is string => typeof l === 'string' && availableLabels.includes(l)
  );

  console.log('[auto-triage:labels] Filtered selectedLabels result', {
    before: rawLabels,
    after: filtered,
  });

  return filtered;
};

/**
 * Parse classification from text using multiple strategies
 */
export const parseClassification = (
  text: string,
  availableLabels: string[]
): ClassificationResult => {
  const strategies = [
    { name: 'codeBlock', fn: () => parseFromCodeBlock(text, availableLabels) },
    { name: 'jsonObject', fn: () => parseFromJsonObject(text, availableLabels) },
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

  console.error('[ClassificationParser] All strategies failed', {
    textLength: text.length,
    textPreview: text.slice(0, 500),
    textTail: text.slice(-500),
    failures,
    hasCodeBlock: /```/.test(text),
    hasClassificationKey: /"classification"/.test(text),
  });

  throw new Error(
    `Failed to parse classification from Cloud Agent response (${text.length} chars). Strategies: ${failures.join('; ')}`
  );
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
      const parsed = JSON.parse(codeBlocks[i]);

      // Validate required fields
      if (parsed.classification && typeof parsed.confidence === 'number' && parsed.intentSummary) {
        if (!('selectedLabels' in parsed)) {
          console.log('[auto-triage:labels] selectedLabels missing from parsed JSON (code block)', {
            classification: parsed.classification,
          });
        }
        return {
          classification: parsed.classification,
          confidence: parsed.confidence,
          intentSummary: parsed.intentSummary,
          relatedFiles: parsed.relatedFiles,
          reasoning: parsed.reasoning,
          selectedLabels: filterValidLabels(parsed.selectedLabels, availableLabels),
        };
      }
    } catch {
      // Try next block
      continue;
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
      const parsed = JSON.parse(jsonObjects[i]);

      // Validate required fields
      if (parsed.classification && typeof parsed.confidence === 'number' && parsed.intentSummary) {
        if (!('selectedLabels' in parsed)) {
          console.log(
            '[auto-triage:labels] selectedLabels missing from parsed JSON (json object)',
            {
              classification: parsed.classification,
            }
          );
        }
        return {
          classification: parsed.classification,
          confidence: parsed.confidence,
          intentSummary: parsed.intentSummary,
          relatedFiles: parsed.relatedFiles,
          reasoning: parsed.reasoning,
          selectedLabels: filterValidLabels(parsed.selectedLabels, availableLabels),
        };
      }
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
