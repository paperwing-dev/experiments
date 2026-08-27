import { describe, expect, it } from 'vitest';
import { formatProgramForDisplay, tokenizeProgramLine } from './format-program';

describe('formatProgramForDisplay', () => {
  it('expands a historical one-line visual program', () => {
    const source = 'async () => ({ points: Array(100).fill().map((_, i) => ({ x: 500 - i * 5, y: 500 - Math.cos(i * 0.1) * 200, z: 0 })), render: { radius: 2, closed: false } })';

    expect(formatProgramForDisplay(source)).toBe([
      'async () => ({',
      '  points: Array(100).fill().map((_, i) => ({',
      '    x: 500 - i * 5,',
      '    y: 500 - Math.cos(i * 0.1) * 200,',
      '    z: 0',
      '  })),',
      '  render: {',
      '    radius: 2,',
      '    closed: false',
      '  }',
      '})',
    ].join('\n'));
  });

  it('preserves source that is already multiline', () => {
    const source = 'async () => {\n  return visual;\n}';
    expect(formatProgramForDisplay(source)).toBe(source);
  });
});

describe('tokenizeProgramLine', () => {
  it('highlights JavaScript without changing its text', () => {
    const source = '  const points = Array.from({ radius: 1.2, closed: false });';
    const tokens = tokenizeProgramLine(source);

    expect(tokens.map((token) => token.text).join('')).toBe(source);
    expect(tokens).toEqual(expect.arrayContaining([
      { kind: 'keyword', text: 'const' },
      { kind: 'builtin', text: 'Array' },
      { kind: 'property', text: 'radius' },
      { kind: 'number', text: '1.2' },
      { kind: 'literal', text: 'false' },
    ]));
  });

  it('keeps strings and comments intact', () => {
    expect(tokenizeProgramLine("return 'spiral'; // label")).toEqual(
      expect.arrayContaining([
        { kind: 'keyword', text: 'return' },
        { kind: 'string', text: "'spiral'" },
        { kind: 'comment', text: '// label' },
      ]),
    );
  });
});
