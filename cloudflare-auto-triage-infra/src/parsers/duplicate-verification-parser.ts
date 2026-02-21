/**
 * DuplicateVerificationParser
 *
 * Extracts and validates duplicate verification results from Cloud Agent responses.
 * Follows the same multi-strategy approach as ClassificationParser.
 */

import { duplicateVerificationResultSchema, type DuplicateVerificationResult } from '../types';

const tryParseCandidate = (parsed: unknown): DuplicateVerificationResult | null => {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const result = duplicateVerificationResultSchema.safeParse(parsed);
  return result.success ? result.data : null;
};

/**
 * Parse duplicate verification result from Cloud Agent response text.
 */
export const parseDuplicateVerification = (text: string): DuplicateVerificationResult => {
  // Strip control characters that might interfere with parsing
  // eslint-disable-next-line no-control-regex
  const cleanText = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  const strategies = [
    { name: 'codeBlock', fn: () => parseFromCodeBlock(cleanText) },
    { name: 'jsonObject', fn: () => parseFromJsonObject(cleanText) },
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

  // Last resort: try the tail of the text (response should end with JSON)
  const tailText = cleanText.slice(-5000);
  try {
    const tailCodeBlockResult = parseFromCodeBlock(tailText);
    if (tailCodeBlockResult) return tailCodeBlockResult;
  } catch {
    // continue
  }
  try {
    const tailJsonResult = parseFromJsonObject(tailText);
    if (tailJsonResult) return tailJsonResult;
  } catch {
    // continue
  }
  failures.push('tailFallback: no matching content in last 5000 chars');

  console.error('[DuplicateVerificationParser] All strategies failed', {
    textLength: text.length,
    textPreview: text.slice(0, 500),
    textTail: text.slice(-500),
    failures,
    hasCodeBlock: /```/.test(text),
    hasIsDuplicateKey: /"isDuplicate"/.test(text),
  });

  throw new Error(
    'Duplicate verification failed — could not parse the agent response. Please retry.'
  );
};

const parseFromCodeBlock = (text: string): DuplicateVerificationResult | null => {
  const codeBlockRegex = /```(?:json|JSON)?\s*\r?\n([\s\S]*?)\r?\n\s*```/g;
  const codeBlocks: string[] = [];
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    codeBlocks.push(match[1]);
  }

  for (let i = codeBlocks.length - 1; i >= 0; i--) {
    try {
      const result = tryParseCandidate(JSON.parse(codeBlocks[i]));
      if (result) return result;
    } catch {
      continue;
    }
  }

  // Fallback: direct tail search for the last code fence pair
  const lastFenceEnd = text.lastIndexOf('```');
  if (lastFenceEnd !== -1) {
    const searchStart = Math.max(0, lastFenceEnd - 10_000);
    const textSlice = text.substring(searchStart, lastFenceEnd);
    const openFenceIdx = textSlice.lastIndexOf('```');
    if (openFenceIdx !== -1) {
      const fenceContent = textSlice.substring(openFenceIdx);
      const contentStart = fenceContent.indexOf('\n');
      if (contentStart !== -1) {
        const jsonContent = fenceContent.substring(contentStart + 1).trim();
        try {
          const result = tryParseCandidate(JSON.parse(jsonContent));
          if (result) return result;
        } catch {
          // Not valid JSON, fall through
        }
      }
    }
  }

  return null;
};

const parseFromJsonObject = (text: string): DuplicateVerificationResult | null => {
  const jsonObjects = extractJsonObjects(text);

  for (let i = jsonObjects.length - 1; i >= 0; i--) {
    try {
      const result = tryParseCandidate(JSON.parse(jsonObjects[i]));
      if (result) return result;
    } catch {
      continue;
    }
  }

  return null;
};

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
        if (looksLikeDuplicateVerification(jsonStr)) {
          objects.push(jsonStr);
        }
        startIndex = -1;
      }
    }
  }

  return objects;
};

const looksLikeDuplicateVerification = (jsonStr: string): boolean => {
  return jsonStr.includes('"isDuplicate"') && jsonStr.includes('"reasoning"');
};
