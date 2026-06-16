import { createInterface } from 'node:readline/promises';
import { PassThrough, type Readable, type Writable } from 'node:stream';

export class UserAbortError extends Error {
  constructor() {
    super('Operation cancelled.');
  }
}

export type SecretInputMode = 'single-line' | 'multiline';

export function normalizeMultilineInput(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

export type PromptDriver = {
  askText(question: string, defaultValue?: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
  askSecret(question: string, mode: SecretInputMode): Promise<string>;
};

type TtyReadable = Readable & {
  isTTY?: boolean;
  setRawMode?: (enabled: boolean) => void;
};

type TtyWritable = Writable & {
  isTTY?: boolean;
};

function createNormalizedInput(input: TtyReadable): Readable {
  const normalized = new PassThrough();
  let dropLineFeedAfterCarriageReturn = false;
  input.on('data', chunk => {
    let output = '';
    for (const character of String(chunk)) {
      if (character === '\r') {
        output += '\n';
        dropLineFeedAfterCarriageReturn = true;
        continue;
      }
      if (character === '\n' && dropLineFeedAfterCarriageReturn) {
        dropLineFeedAfterCarriageReturn = false;
        continue;
      }
      dropLineFeedAfterCarriageReturn = false;
      output += character;
    }
    if (output.length > 0) normalized.write(output);
  });
  return normalized;
}

async function askVisible(
  input: Readable,
  output: Writable,
  question: string,
  defaultValue?: string
): Promise<string> {
  input.resume();
  const prompt = defaultValue === undefined ? question : `${question} [${defaultValue}] `;
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(prompt);
    return answer.length === 0 && defaultValue !== undefined ? defaultValue : answer;
  } finally {
    rl.close();
  }
}

function readHidden(
  input: Readable,
  ttyInput: TtyReadable,
  output: TtyWritable,
  question: string,
  mode: SecretInputMode
): Promise<string> {
  if (!ttyInput.isTTY || !output.isTTY || !ttyInput.setRawMode) {
    throw new Error('Hidden value input requires an interactive TTY.');
  }

  output.write(question);
  input.setEncoding('utf8');
  ttyInput.setRawMode(true);
  input.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    let currentLine = '';
    let finished = false;
    const sentinel = '::end';

    const cleanup = () => {
      input.off('data', onData);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      ttyInput.setRawMode?.(false);
      input.pause();
    };

    const finish = (result: string) => {
      if (finished) return;
      finished = true;
      cleanup();
      output.write('\n');
      resolve(result);
    };

    const onSignal = () => {
      if (finished) return;
      finished = true;
      cleanup();
      output.write('\n');
      reject(new UserAbortError());
    };

    const processNewline = () => {
      if (mode === 'single-line') {
        finish(value);
        return;
      }
      if (currentLine === sentinel) {
        finish(normalizeMultilineInput(value));
        return;
      }
      value += `${currentLine}\n`;
      currentLine = '';
    };

    const onData = (chunk: string | Buffer) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          onSignal();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (mode === 'single-line') {
            value = [...value].slice(0, -1).join('');
          } else {
            currentLine = [...currentLine].slice(0, -1).join('');
          }
          continue;
        }
        if (character === '\n') {
          processNewline();
          if (finished) return;
          continue;
        }
        if (mode === 'single-line') value += character;
        else currentLine += character;
      }
    };

    input.on('data', onData);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}

export function createTerminalPrompts(
  input: TtyReadable = process.stdin,
  output: TtyWritable = process.stdout
): PromptDriver {
  const normalizedInput = createNormalizedInput(input);
  return {
    askText: (question, defaultValue) =>
      askVisible(normalizedInput, output, question, defaultValue),
    confirm: async question => {
      const answer = await askVisible(normalizedInput, output, `${question} [y/N] `);
      return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
    },
    askSecret: (question, mode) => {
      const suffix = mode === 'multiline' ? ' (finish with a line containing ::end)' : '';
      return readHidden(normalizedInput, input, output, `${question}${suffix}: `, mode);
    },
  };
}
