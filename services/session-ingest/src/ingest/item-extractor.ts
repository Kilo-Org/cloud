import { Tokenizer, TokenParser, TokenType } from '@streamparser/json';

import { MAX_SINGLE_ITEM_BYTES } from '../util/ingest-limits';

type ItemExtractorOptions = {
  logErrors?: boolean;
  logOversizedItems?: boolean;
  validateStructure?: boolean;
};

type ContainerState =
  | { type: 'object'; state: 'key_or_end' | 'key' | 'colon' | 'value' | 'comma_or_end' }
  | { type: 'array'; state: 'value_or_end' | 'value' | 'comma_or_end' };

export function createItemExtractor(r2Key: string, options: ItemExtractorOptions = {}) {
  const pending: Record<string, unknown>[] = [];
  let parseError: Error | null = null;
  let skippedItemCount = 0;
  let oversizedItemCount = 0;
  let rootState: 'value' | 'complete' = 'value';
  const containers: ContainerState[] = [];

  // Depth: 0=before root, 1=root object, 2=$.data array, 3+=inside an item
  let depth = 0;
  let pendingKey: string | undefined;
  let foundDataArray = false;
  let dataArray: 'present' | 'missing' | 'wrong_type' = 'missing';
  let itemStartOffset = 0;
  let skippingItem = false;
  let itemParser: TokenParser | null = null;

  function startItemParser() {
    itemParser = new TokenParser({ paths: ['$'], keepStack: false });
    itemParser.onValue = ({ value, stack }) => {
      if (stack.length === 0 && value != null) {
        pending.push(value as Record<string, unknown>);
      }
    };
    itemParser.onError = (err: Error) => {
      if (options.logErrors !== false) {
        console.error('TokenParser error in queue consumer', { r2Key, error: err.message });
      }
    };
  }

  function setParseError(message: string) {
    if (parseError) return;
    parseError = new Error(message);
    if (options.logErrors !== false) {
      console.error('Tokenizer error in queue consumer', { r2Key, error: message });
    }
  }

  function consumeValue() {
    const parent = containers.at(-1);
    if (!parent) {
      if (rootState !== 'value') return false;
      rootState = 'complete';
      return true;
    }
    if (parent.type === 'object') {
      if (parent.state !== 'value') return false;
      parent.state = 'comma_or_end';
      return true;
    }
    if (parent.state !== 'value' && parent.state !== 'value_or_end') return false;
    parent.state = 'comma_or_end';
    return true;
  }

  function validateToken(token: TokenType): boolean {
    const current = containers.at(-1);

    if (current?.type === 'object') {
      if (
        (current.state === 'key_or_end' || current.state === 'key') &&
        token === TokenType.STRING
      ) {
        current.state = 'colon';
        return true;
      }
      if (current.state === 'colon' && token === TokenType.COLON) {
        current.state = 'value';
        return true;
      }
      if (current.state === 'comma_or_end' && token === TokenType.COMMA) {
        current.state = 'key';
        return true;
      }
      if (
        (current.state === 'key_or_end' || current.state === 'comma_or_end') &&
        token === TokenType.RIGHT_BRACE
      ) {
        containers.pop();
        return true;
      }
    } else if (current?.type === 'array') {
      if (current.state === 'comma_or_end' && token === TokenType.COMMA) {
        current.state = 'value';
        return true;
      }
      if (
        (current.state === 'value_or_end' || current.state === 'comma_or_end') &&
        token === TokenType.RIGHT_BRACKET
      ) {
        containers.pop();
        return true;
      }
    }

    const isScalar =
      token === TokenType.STRING ||
      token === TokenType.NUMBER ||
      token === TokenType.TRUE ||
      token === TokenType.FALSE ||
      token === TokenType.NULL;
    if (isScalar) return consumeValue();

    if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) {
      if (!consumeValue()) return false;
      containers.push(
        token === TokenType.LEFT_BRACE
          ? { type: 'object', state: 'key_or_end' }
          : { type: 'array', state: 'value_or_end' }
      );
      return true;
    }

    return false;
  }

  const tokenizer = new Tokenizer();
  tokenizer.onToken = ({ token, value, offset }) => {
    if (options.validateStructure && !validateToken(token)) {
      setParseError(`Unexpected JSON token ${TokenType[token]}`);
      return;
    }

    const isOpen = token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET;
    const isClose = token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET;

    if (skippingItem) {
      if (isOpen) depth++;
      if (isClose) {
        depth--;
        if (depth === 2) skippingItem = false;
      }
      return;
    }

    if (foundDataArray && depth >= 3) {
      if (offset - itemStartOffset > MAX_SINGLE_ITEM_BYTES) {
        skippedItemCount += 1;
        oversizedItemCount += 1;
        if (options.logOversizedItems !== false) {
          console.warn('Skipping oversized item in queue consumer (byte budget exceeded)', {
            r2Key,
            bytesConsumed: offset - itemStartOffset,
            maxBytes: MAX_SINGLE_ITEM_BYTES,
          });
        }
        skippingItem = true;
        itemParser = null;
        if (isOpen) depth++;
        if (isClose) depth--;
        if (depth === 2) skippingItem = false;
        return;
      }

      itemParser?.write({ token, value });
      if (isOpen) depth++;
      if (isClose) {
        depth--;
        if (depth === 2) itemParser = null;
      }
      return;
    }

    if (isOpen) {
      const opensDataArray =
        depth === 1 && token === TokenType.LEFT_BRACKET && pendingKey === 'data';
      if (foundDataArray && depth === 2 && token === TokenType.LEFT_BRACKET) {
        skippedItemCount += 1;
        skippingItem = true;
        depth++;
        return;
      }
      if (depth === 1 && pendingKey === 'data') {
        dataArray = opensDataArray ? 'present' : 'wrong_type';
      }
      depth++;

      if (foundDataArray && depth === 3 && token === TokenType.LEFT_BRACE) {
        itemStartOffset = offset;
        startItemParser();
        itemParser?.write({ token, value });
        return;
      }

      if (opensDataArray) {
        foundDataArray = true;
        pendingKey = undefined;
        return;
      }

      pendingKey = undefined;
      return;
    }

    if (isClose) {
      if (foundDataArray && depth === 2 && token === TokenType.RIGHT_BRACKET) {
        foundDataArray = false;
      }
      depth--;
      return;
    }

    if (foundDataArray && depth === 2 && token !== TokenType.COMMA && token !== TokenType.COLON) {
      skippedItemCount += 1;
    }

    if (depth === 1 && pendingKey === 'data' && token !== TokenType.COLON) {
      dataArray = 'wrong_type';
    }
    if (depth === 1 && token === TokenType.STRING) {
      pendingKey = value as string;
    } else if (token !== TokenType.COLON) {
      pendingKey = undefined;
    }
  };

  tokenizer.onError = (err: Error) => {
    if (options.logErrors !== false) {
      console.error('Tokenizer error in queue consumer', { r2Key, error: err.message });
    }
    parseError = err;
  };

  return {
    tokenizer,
    pending,
    getParseError: () => parseError,
    getDataArray: () => dataArray,
    getSkippedItemCount: () => skippedItemCount,
    getOversizedItemCount: () => oversizedItemCount,
    isComplete: () =>
      (!options.validateStructure || (rootState === 'complete' && containers.length === 0)) &&
      depth === 0 &&
      itemParser === null &&
      !skippingItem,
  };
}
