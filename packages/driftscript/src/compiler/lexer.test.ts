import { describe, expect, it } from 'vitest';
import { tokenize } from './lexer.ts';
import { KEYWORDS, PRIMITIVES, PUNCTUATION, isSoftKeyword } from './tokens.ts';

const PULSE = `data PulseState {
    phase: f32 = 0
}
`;

describe('the lexer', () => {
  it('reads a data declaration into tokens with exact kinds', () => {
    const { tokens, diagnostics } = tokenize(PULSE);
    expect(diagnostics).toEqual([]);

    const shape = tokens.filter((t) => t.kind !== 'eof').map((t) => [t.kind, t.text]);
    expect(shape).toEqual([
      ['keyword', 'data'],
      ['ident', 'PulseState'],
      ['punct', '{'],
      ['ident', 'phase'],
      ['punct', ':'],
      ['keyword', 'f32'],
      ['punct', '='],
      ['number', '0'],
      ['punct', '}'],
    ]);
  });

  it('gives every token a span that slices back to its own text', () => {
    const source = 'fn update(state: mut PulseState, dt: f32) {\n    state.phase += dt\n}\n';
    const { tokens } = tokenize(source);
    for (const token of tokens) {
      if (token.kind === 'eof') continue;
      expect(source.slice(token.start, token.end)).toBe(token.text);
    }
  });

  it('ends with exactly one eof token, spanning nothing at the end of the source', () => {
    const { tokens } = tokenize(PULSE);
    expect(tokens.filter((t) => t.kind === 'eof')).toHaveLength(1);
    const last = tokens[tokens.length - 1];
    expect(last.kind).toBe('eof');
    expect(last.start).toBe(PULSE.length);
    expect(last.end).toBe(PULSE.length);
  });

  it('reads a compound assignment as one token, not two', () => {
    const { tokens } = tokenize('a += b');
    expect(tokens.map((t) => t.text)).toContain('+=');
    expect(tokens.filter((t) => t.text === '+')).toHaveLength(0);
  });

  it('reads the overflow operators as one token each, longest first', () => {
    for (const op of ['+%', '+|', '-%', '-|', '*%', '*|']) {
      const { tokens } = tokenize(`a ${op} b`);
      expect(tokens.map((t) => t.text)).toContain(op);
      expect(tokens.filter((t) => t.text === op[0])).toHaveLength(0);
    }
  });

  it('treats every primitive as a keyword, so the grammar and the parser cannot disagree', () => {
    for (const primitive of PRIMITIVES) {
      const { tokens } = tokenize(primitive);
      expect(tokens[0].kind).toBe('keyword');
    }
    expect([...KEYWORDS]).toEqual([...new Set(KEYWORDS)]);
  });

  it('does not lex a keyword out of the middle of an identifier', () => {
    const { tokens } = tokenize('f32x letter data_source');
    expect(tokens.filter((t) => t.kind !== 'eof').map((t) => [t.kind, t.text])).toEqual([
      ['ident', 'f32x'],
      ['ident', 'letter'],
      ['ident', 'data_source'],
    ]);
  });

  it('reads an annotation as its own kind, carrying the name without the at sign', () => {
    const { tokens } = tokenize('@deterministic\nfn f() {}\n');
    expect(tokens[0]).toMatchObject({ kind: 'annotation', text: '@deterministic' });
  });

  it('reads line and block comments as tokens the parser can skip', () => {
    const { tokens, diagnostics } = tokenize('// one\n/* two */ let a = 1\n');
    expect(diagnostics).toEqual([]);
    const comments = tokens.filter((t) => t.kind === 'comment');
    expect(comments.map((t) => t.text)).toEqual(['// one', '/* two */']);
  });

  it('reads a number with a unit suffix as a number and a unit, not one identifier', () => {
    const { tokens } = tokenize('let d = 30m');
    const shape = tokens.filter((t) => t.kind !== 'eof').map((t) => [t.kind, t.text]);
    expect(shape).toContainEqual(['number', '30']);
    expect(shape).toContainEqual(['unit', 'm']);
  });

  it('reads a decimal number as one token', () => {
    const { tokens } = tokenize('0.25');
    expect(tokens[0]).toMatchObject({ kind: 'number', text: '0.25' });
  });

  it('reports an unterminated string with a span rather than throwing', () => {
    const { diagnostics } = tokenize('let s = "open');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('DS0001');
    expect(diagnostics[0].message).toContain('unterminated');
  });

  it('reports an unterminated block comment rather than swallowing the file', () => {
    const { diagnostics } = tokenize('/* open\nlet a = 1\n');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('DS0002');
    expect(diagnostics[0].message).toContain('unterminated');
  });

  it('reports an unexpected character and keeps going rather than stopping at the first', () => {
    const { tokens, diagnostics } = tokenize('let a = 1\nlet b # 2\nlet c $ 3\n');
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].code).toBe('DS0003');
    expect(tokens.some((t) => t.text === 'c')).toBe(true);
  });

  it('knows every punctuation entry it declares', () => {
    for (const punct of PUNCTUATION) {
      const { tokens, diagnostics } = tokenize(punct);
      expect(diagnostics).toEqual([]);
      expect(tokens[0]).toMatchObject({ kind: 'punct', text: punct });
    }
  });
});

describe('the entity-form keywords', () => {
  it('lets `entity` and `component` name a variable, and does not let `query`', () => {
    /*
     * `query<T>()` needs type arguments where `<` is otherwise a comparison, so a soft `query`
     * would leave `query < 5` ambiguous between a comparison and the head of a query. The other
     * nine are words a script author reaches for constantly.
     */
    expect(isSoftKeyword('entity')).toBe(true);
    expect(isSoftKeyword('component')).toBe(true);
    expect(isSoftKeyword('system')).toBe(true);
    expect(isSoftKeyword('at')).toBe(true);
    expect(isSoftKeyword('query')).toBe(false);
  });

  it('lexes all ten as keywords rather than identifiers', () => {
    for (const word of [
      'component', 'entity', 'system', 'prefab', 'require',
      'reads', 'writes', 'update', 'at', 'query',
    ]) {
      const { tokens } = tokenize(word);
      const [first] = tokens;
      expect(first?.kind, word).toBe('keyword');
    }
  });

  const shapeOf = (source: string): [string, string][] =>
    tokenize(source).tokens.filter((t) => t.kind !== 'eof').map((t) => [t.kind, t.text]);

  it('lexes `1Hz` as a number and a unit, the way every other suffix lexes', () => {
    expect(shapeOf('1Hz')).toEqual([
      ['number', '1'],
      ['unit', 'Hz'],
    ]);
  });

  it('leaves the other suffixes where they were, so Hz did not disturb the order', () => {
    /* The suffix list is in prefix-safe order — `ms` has to be found before `m`, or `250ms` lexes
       as `250m` and a stray `s`. `Hz` starts with a letter nothing else does, and this is what
       says so rather than leaving it to the reading of a list. */
    expect(shapeOf('250ms')).toEqual([
      ['number', '250'],
      ['unit', 'ms'],
    ]);
    expect(shapeOf('40m')).toEqual([
      ['number', '40'],
      ['unit', 'm'],
    ]);
  });
});
