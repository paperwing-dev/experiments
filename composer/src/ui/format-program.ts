export function formatProgramForDisplay(value: string): string {
  const source = value.trim();
  if (!source || source.includes('\n')) return source;

  const lines: string[] = [];
  const braceParentheses: number[] = [];
  let current = '';
  let indentation = 0;
  let parentheses = 0;
  let brackets = 0;
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;

  const append = (text: string) => {
    if (!current) current = '  '.repeat(indentation);
    current += text;
  };
  const flush = () => {
    const line = current.trimEnd();
    if (line.trim()) lines.push(line);
    current = '';
  };
  const nextNonSpace = (from: number) => {
    for (let index = from; index < source.length; index += 1) {
      if (!/\s/.test(source[index] ?? '')) return source[index];
    }
    return '';
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';

    if (quote) {
      append(character);
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      append(character);
    } else if (/\s/.test(character)) {
      if (current && !current.endsWith(' ')) current += ' ';
    } else if (character === '(') {
      parentheses += 1;
      append(character);
    } else if (character === ')') {
      parentheses = Math.max(0, parentheses - 1);
      append(character);
    } else if (character === '[') {
      brackets += 1;
      append(character);
    } else if (character === ']') {
      brackets = Math.max(0, brackets - 1);
      append(character);
    } else if (character === '{') {
      append(character);
      flush();
      indentation += 1;
      braceParentheses.push(parentheses);
    } else if (character === '}') {
      flush();
      indentation = Math.max(0, indentation - 1);
      braceParentheses.pop();
      append(character);
      if (![')', ']', ',', ';'].includes(nextNonSpace(index + 1))) flush();
    } else if (character === ';') {
      append(character);
      if (parentheses === 0 && brackets === 0) flush();
    } else if (character === ',') {
      append(character);
      if (braceParentheses.at(-1) === parentheses) flush();
    } else if (character === ':') {
      append(':');
      if (nextNonSpace(index + 1)) current += ' ';
      while (/\s/.test(source[index + 1] ?? '')) index += 1;
    } else {
      append(character);
    }
  }

  flush();
  return lines.join('\n');
}

export type ProgramTokenKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'keyword'
  | 'literal'
  | 'builtin'
  | 'property'
  | 'number';

export interface ProgramToken {
  kind: ProgramTokenKind;
  text: string;
}

const PROGRAM_TOKEN = /(?<comment>\/\/.*|\/\*.*?\*\/)|(?<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(?<keyword>\b(?:async|await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|switch|throw|try|typeof|var|void|while|yield)\b)|(?<literal>\b(?:true|false|null|undefined|NaN|Infinity)\b)|(?<builtin>\b(?:Array|Math|Number|Object|Promise|String)\b)|(?<property>\b[A-Za-z_$][\w$]*(?=\s*:))|(?<number>\b(?:0[xX][\dA-Fa-f]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b)/g;

export function tokenizeProgramLine(line: string): ProgramToken[] {
  const tokens: ProgramToken[] = [];
  let cursor = 0;

  for (const match of line.matchAll(PROGRAM_TOKEN)) {
    const start = match.index;
    if (start > cursor) {
      tokens.push({ kind: 'plain', text: line.slice(cursor, start) });
    }

    const groups = match.groups ?? {};
    const kind: ProgramTokenKind = groups.comment
      ? 'comment'
      : groups.string
        ? 'string'
        : groups.keyword
          ? 'keyword'
          : groups.literal
            ? 'literal'
            : groups.builtin
              ? 'builtin'
              : groups.property
                ? 'property'
                : 'number';
    tokens.push({ kind, text: match[0] });
    cursor = start + match[0].length;
  }

  if (cursor < line.length) {
    tokens.push({ kind: 'plain', text: line.slice(cursor) });
  }
  return tokens;
}
