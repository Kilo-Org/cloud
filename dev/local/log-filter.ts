type ParserState =
  | 'normal'
  | 'escape'
  | 'csi'
  | 'osc'
  | 'oscEscape'
  | 'controlString'
  | 'controlStringEscape'
  | 'skipNext';

let parserState: ParserState = 'normal';
let line = '';
let pendingCarriageReturn = false;

process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk: string) => {
  for (const char of chunk) {
    processChar(char);
  }
});

process.stdin.on('end', flushLineIfNeeded);

function processChar(char: string): void {
  switch (parserState) {
    case 'normal':
      processNormalChar(char);
      return;
    case 'escape':
      processEscapeChar(char);
      return;
    case 'csi':
      if (isAnsiFinalChar(char)) {
        parserState = 'normal';
      }
      return;
    case 'osc':
      if (char === '\x07') {
        parserState = 'normal';
      } else if (char === '\x1b') {
        parserState = 'oscEscape';
      }
      return;
    case 'oscEscape':
      parserState = char === '\\' ? 'normal' : 'osc';
      return;
    case 'controlString':
      if (char === '\x07') {
        parserState = 'normal';
      } else if (char === '\x1b') {
        parserState = 'controlStringEscape';
      }
      return;
    case 'controlStringEscape':
      parserState = char === '\\' ? 'normal' : 'controlString';
      return;
    case 'skipNext':
      parserState = 'normal';
      return;
  }
}

function processNormalChar(char: string): void {
  if (char === '\x1b') {
    parserState = 'escape';
    return;
  }

  if (pendingCarriageReturn) {
    pendingCarriageReturn = false;
    if (char === '\n') {
      emitLine();
      return;
    }
    line = '';
  }

  if (char === '\r') {
    pendingCarriageReturn = true;
    return;
  }

  if (char === '\n') {
    emitLine();
    return;
  }

  if (char === '\b') {
    line = line.slice(0, -1);
    return;
  }

  if (char === '\t') {
    line += char;
    return;
  }

  const charCode = char.charCodeAt(0);
  if (charCode >= 0x20 && charCode !== 0x7f) {
    line += char;
  }
}

function processEscapeChar(char: string): void {
  switch (char) {
    case '[':
      parserState = 'csi';
      return;
    case ']':
      parserState = 'osc';
      return;
    case 'P':
    case '^':
    case '_':
    case 'X':
      parserState = 'controlString';
      return;
    case '(':
    case ')':
    case '*':
    case '+':
    case '-':
    case '.':
    case '/':
    case '#':
      parserState = 'skipNext';
      return;
    default:
      parserState = 'normal';
  }
}

function isAnsiFinalChar(char: string): boolean {
  const charCode = char.charCodeAt(0);
  return charCode >= 0x40 && charCode <= 0x7e;
}

function emitLine(): void {
  pendingCarriageReturn = false;
  process.stdout.write(`${line}\n`);
  line = '';
}

function flushLineIfNeeded(): void {
  if (line !== '') {
    process.stdout.write(`${line}\n`);
  }
}
