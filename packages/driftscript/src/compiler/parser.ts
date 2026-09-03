/**
 * Tokens to a syntax tree, reporting rather than throwing.
 *
 * Recursive descent with precedence climbing, hand-written, for the same reason the lexer is: the
 * grammar is small, fixed, and has to be readable by whoever adds to it. A parser generator would
 * be a build step this repository does not have and a second definition of the language beside
 * `tokens.ts`.
 *
 * **Nothing throws.** A syntax error is a diagnostic, and the parser resynchronises at the next
 * top-level keyword so a second error in the same file is still reported. The cost is that a badly
 * broken file produces a tree with holes in it, which is why `compileDriftScript` refuses to check
 * a module that produced syntax diagnostics: a recovered tree is good enough to keep *parsing* and
 * not good enough to draw conclusions from.
 *
 * Semicolons are optional, so a statement ends at a newline or a closing brace. The cost is that an
 * expression cannot span a line break before its operator without parentheses. What would make that
 * wrong is an expression syntax where a leading operator on the next line is idiomatic — which is a
 * style this language does not have and would be a breaking change to acquire.
 */
import type {
  DataDecl,
  Decl,
  EnumDecl,
  EnumVariant,
  Expr,
  FieldDecl,
  FnDecl,
  ImportDecl,
  MatchArm,
  Module,
  ParamDecl,
  Pattern,
  Span,
  Stmt,
  EventDecl,
  OnDecl,
  StateDecl,
  TaskDecl,
  TypeRef,
  ComponentDecl,
  EntityDecl,
  SystemDecl,
  PrefabDecl,
  QuerySpec,
  EditorMeta,
} from './ast.ts';
import type { Diagnostic, DiagnosticCode } from './diagnostics.ts';
import { type Token, tokenize } from './lexer.ts';
import { isPrimitive, isSoftKeyword } from './tokens.ts';
import { DEFAULT_FIXED_STEPS_PER_SECOND, ratesDividing } from './target.ts';
import { isIdentifier, namespaceOf, suggestedAlias } from './namespace.ts';

export interface ParseResult {
  readonly module: Module;
  readonly diagnostics: readonly Diagnostic[];
}



/** Keywords that can begin a top-level declaration, which is where recovery resynchronises. */
const DECL_STARTS: ReadonlySet<string> = new Set([
  'data',
  'fn',
  'enum',
  'import',
  'task',
  'event',
  'on',
  'state',
  'component',
  'entity',
  'system',
  'prefab',
]);

/**
 * The three clocks an `await` can name, and what each is called in the runtime.
 *
 * A table rather than a check against the runtime's own `Clock` union, because the two are
 * different vocabularies on purpose: the source says what a script author means by a wait, and the
 * runtime says which of a loop's numbers answers it.
 */
const CLOCK_NAMES: Readonly<Record<string, 'fixed' | 'frame' | 'wall'>> = {
  fixedTime: 'fixed',
  frameTime: 'frame',
  wallTime: 'wall',
};

/** Operators that form a compound assignment statement. */
const COMPOUND_OPS: ReadonlySet<string> = new Set(['+=', '-=', '*=', '/=']);

/**
 * Binary operator precedence, loosest first.
 *
 * A table rather than a function per level, because a function per level is a function to add every
 * time an operator arrives and the arithmetic is identical at each. The overflow spellings sit at
 * the precedence of the operator they are a variant of, which is the only choice that lets
 * `a +% b * c` mean what a reader expects.
 */
const PRECEDENCE: readonly (readonly string[])[] = [
  ['||'],
  ['&&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['+', '-', '+%', '+|', '-%', '-|'],
  ['*', '/', '%', '*%', '*|'],
];

const UNARY_OPS: ReadonlySet<string> = new Set(['-', '!']);

class Parser {
  private readonly tokens: readonly Token[];
  private readonly diagnostics: Diagnostic[] = [];
  private readonly file: string;
  private readonly source: string;
  private readonly fixedStepsPerSecond: number;
  private at = 0;

  constructor(
    file: string,
    source: string,
    tokens: readonly Token[],
    lexDiagnostics: readonly Diagnostic[],
    fixedStepsPerSecond: number = DEFAULT_FIXED_STEPS_PER_SECOND,
  ) {
    this.file = file;
    this.source = source;
    this.fixedStepsPerSecond = fixedStepsPerSecond;
    /* Comments are dropped here rather than in the lexer, because the formatter and the language
       server both want them and both read the token stream rather than the tree. */
    this.tokens = tokens.filter((t) => t.kind !== 'comment');
    this.diagnostics.push(...lexDiagnostics);
  }

  private peek(offset = 0): Token {
    const at = this.at + offset;
    return this.tokens[Math.max(0, Math.min(at, this.tokens.length - 1))];
  }

  private next(): Token {
    const token = this.peek();
    if (this.at < this.tokens.length - 1) this.at += 1;
    return token;
  }

  private atEnd(): boolean {
    return this.peek().kind === 'eof';
  }

  private check(kind: Token['kind'], text?: string): boolean {
    const token = this.peek();
    return token.kind === kind && (text === undefined || token.text === text);
  }

  private accept(kind: Token['kind'], text?: string): Token | null {
    return this.check(kind, text) ? this.next() : null;
  }

  /**
   * Take the next token as an identifier, accepting a soft keyword in that role.
   *
   * `tokens.ts` carries the argument. In short: the design's canonical example names a parameter
   * `state`, and seven more keywords collide with signatures a behaviour language will be asked to
   * parse. Reserving a word everywhere costs the language its clearest nouns; reserving it only
   * where it can start a construct costs a little over-eager highlighting.
   *
   * Every binding and expression position goes through here rather than through `accept('ident')`.
   * A position that does not is a position where `state` is still reserved, which is invisible
   * until somebody writes that name.
   */
  private acceptIdentLike(): Token | null {
    const token = this.peek();
    if (token.kind === 'ident') return this.next();
    if (token.kind === 'keyword' && isSoftKeyword(token.text)) return this.next();
    return null;
  }

  private report(code: DiagnosticCode, message: string, span: Span): void {
    this.diagnostics.push({ code, severity: 'error', message, file: this.file, ...span });
  }

  /** Consume the expected token, or report and return null without consuming. */
  private expect(kind: Token['kind'], text: string, code: DiagnosticCode): Token | null {
    const token = this.accept(kind, text);
    if (token !== null) return token;
    const found = this.peek();
    this.report(
      code,
      `expected \`${text}\` but found ${found.kind === 'eof' ? 'the end of the file' : `\`${found.text}\``}`,
      { start: found.start, end: found.end },
    );
    return null;
  }

  /**
   * Whether a newline separates the previous token from the next one.
   *
   * The lexer discards whitespace, so the parser asks the source. Two constructs need it and both
   * are ambiguities that only a line break resolves: a bare `return`, and telling `Name { … }` as a
   * record literal from `if cond { … }` as a condition and its block.
   */
  private startsNewLine(): boolean {
    const previous = this.peek(-1);
    const next = this.peek();
    return this.source.slice(previous.end, next.start).includes('\n');
  }

  /**
   * Skip forward to the next thing that can start a declaration.
   *
   * This is the whole of the error recovery and it is deliberately blunt. A cleverer strategy —
   * inserting the token the parser wanted, say — produces a tree that looks complete and is not,
   * and the checker downstream then reports type errors about syntax somebody never wrote.
   */
  private resynchronise(): void {
    while (!this.atEnd()) {
      if (this.peek().kind === 'keyword' && DECL_STARTS.has(this.peek().text)) return;
      this.next();
    }
  }

  parseModule(): Module {
    const imports: ImportDecl[] = [];
    const decls: Decl[] = [];

    while (!this.atEnd()) {
      const before = this.at;

      /* Annotations attach to the declaration that follows, so they are collected here rather than
         inside each `parse*` — one place that has to know they stack. */
      const annotations: string[] = [];
      const annotationArgs = new Map<string, string>();
      while (this.check('annotation')) {
        const name = this.next().text.slice(1);
        annotations.push(name);
        /*
         * An optional `(key: "value")` list. Kept as strings on a side map rather than
         * enriching `annotations`, so every existing reader of that array is untouched
         * — twelve call sites that care only whether a name is present.
         */
        if (this.check('punct', '(')) this.parseAnnotationArgs(name, annotationArgs);
      }

      if (this.check('keyword', 'import')) {
        const parsed = this.parseImport();
        if (parsed !== null) imports.push(parsed);
      } else if (this.check('keyword', 'let') || this.check('keyword', 'var')) {
        const parsed = this.parseModuleConst();
        if (parsed !== null) decls.push(parsed);
      } else if (this.check('keyword', 'data')) {
        const parsed = this.parseData(annotations);
        if (parsed !== null) decls.push(parsed);
      } else if (this.check('keyword', 'enum')) {
        const parsed = this.parseEnum();
        if (parsed !== null) decls.push(parsed);
      } else if (this.check('keyword', 'fn')) {
        const parsed = this.parseFn(annotations, annotationArgs);
        if (parsed !== null) decls.push(parsed);
      } else if (this.check('keyword', 'task')) {
        const parsed = this.parseTask(annotations);
        if (parsed !== null) decls.push(parsed);
      } else if (this.check('keyword', 'event')) {
        const parsed = this.parseEvent();
        if (parsed !== null) decls.push(parsed);
      } else if (this.check('keyword', 'on')) {
        const parsed = this.parseOn();
        if (parsed !== null) decls.push(parsed);
      } else if (this.check('keyword', 'component')) {
        const parsed = this.parseComponent();
        if (parsed !== null) decls.push(parsed);
      } else if (this.check('keyword', 'entity')) {
        const parsed = this.parseEntity();
        if (parsed !== null) decls.push(parsed);
      } else if (this.check('keyword', 'system')) {
        const parsed = this.parseSystem(annotations);
        if (parsed !== null) decls.push(parsed);
      } else if (this.check('keyword', 'prefab')) {
        const parsed = this.parsePrefab();
        if (parsed !== null) decls.push(parsed);
      } else if (this.check('keyword', 'state') && this.peek(1).kind === 'ident') {
        const parsed = this.parseState();
        if (parsed !== null) decls.push(parsed);
      } else {
        const found = this.peek();
        this.report('DS0100', `expected a declaration but found \`${found.text}\``, {
          start: found.start,
          end: found.end,
        });
        this.next();
        this.resynchronise();
        continue;
      }

      /* A parse that consumed nothing would loop forever. This cannot happen while every branch
         above either consumes or resynchronises, and the guard is here because "cannot happen" is
         how a compiler hangs on a malformed file rather than reporting one. */
      if (this.at === before) this.next();
    }

    return { imports, decls };
  }

  private parseImport(): ImportDecl | null {
    const start = this.next().start;
    if (this.expect('punct', '{', 'DS0101') === null) {
      this.resynchronise();
      return null;
    }

    const names: string[] = [];
    while (!this.atEnd() && !this.check('punct', '}')) {
      const name = this.acceptIdentLike();
      if (name === null) break;
      names.push(name.text);
      if (this.accept('punct', ',') === null) break;
    }

    if (this.expect('punct', '}', 'DS0102') === null) {
      this.resynchronise();
      return null;
    }
    if (this.expect('keyword', 'from', 'DS0103') === null) {
      this.resynchronise();
      return null;
    }

    const module = this.accept('string');
    if (module === null) {
      const found = this.peek();
      this.report('DS0104', 'expected a module name in quotes after `from`', {
        start: found.start,
        end: found.end,
      });
      this.resynchronise();
      return null;
    }

    const specifier = module.text.slice(1, -1);
    /* `./` and `../` and nothing else. A bare specifier is a capability module, whoever provides
       it — see `ImportDecl.relative` for why this is syntax rather than a lookup. */
    const relative = specifier.startsWith('./') || specifier.startsWith('../');

    let alias: string | undefined;
    let end = module.end;
    if (this.accept('keyword', 'as') !== null) {
      const named = this.acceptIdentLike();
      if (named === null) {
        const found = this.peek();
        this.report('DS0138', 'expected a name after `as`', {
          start: found.start,
          end: found.end,
        });
        this.resynchronise();
        return null;
      }
      alias = named.text;
      end = named.end;
    }

    /*
     * **A namespace is an identifier and a specifier is a string, and the two do not always meet.**
     * `drift/2d` derives `2d`, which lexes as a number followed by an identifier, so a call into it
     * could not be written at all — the failure arrived as `\`d\` is not defined` from inside the
     * author's own call, which names nothing they can act on. Refused here instead, at the import,
     * with the line to write.
     *
     * Relative specifiers are exempt: they name a file and bring their names in directly rather
     * than through a namespace, which is what `ImportDecl.relative` decides.
     */
    if (!relative && alias === undefined && !isIdentifier(namespaceOf(specifier))) {
      this.report(
        'DS0139',
        `\`${specifier}\` cannot be named directly, because \`${namespaceOf(specifier)}\` is not an ` +
          `identifier. Import it with a name: \`from "${specifier}" as ${suggestedAlias(specifier)}\``,
        { start, end: module.end },
      );
      return null;
    }

    return {
      kind: 'import',
      module: specifier,
      names,
      relative,
      ...(alias === undefined ? {} : { alias }),
      span: { start, end },
    };
  }

  private parseData(annotations: readonly string[] = []): DataDecl | null {
    const start = this.next().start;
    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0105', 'expected a name after `data`', { start: found.start, end: found.end });
      this.resynchronise();
      return null;
    }
    /*
     * The base clause: `:` then one name, before the brace.
     *
     * No new keyword — the lexer already produces `:` as punctuation, and a keyword would be an
     * eighth soft one bought for nothing. What that costs is that a reader meets `:` here meaning
     * "extends" and three lines later meaning "has type"; what makes it readable anyway is the
     * position, since a type annotation never follows a record's name.
     */
    let base: { name: string; span: Span } | undefined;
    if (this.accept('punct', ':') !== null) {
      const baseName = this.acceptIdentLike();
      if (baseName === null) {
        const found = this.peek();
        this.report('DS0105', 'expected the name of a base record after `:`', {
          start: found.start,
          end: found.end,
        });
        this.resynchronise();
        return null;
      }
      base = { name: baseName.text, span: { start: baseName.start, end: baseName.end } };

      /*
       * A second base is refused here rather than collected and rejected later.
       *
       * Two bases raise field collision, layout order and diamond questions whose answers are all
       * arbitrary, and every one of those answers is load-bearing for the stable field ids of
       * Phase 5. Refusing at the parser keeps the message next to what somebody wrote; refusing at
       * the checker would mean inventing a representation for a thing that is never legal.
       */
      if (this.check('punct', ',')) {
        const found = this.peek();
        this.report(
          'DS0105',
          'a record may name one base. Two bases would make field order and collisions a matter ' +
            'of arbitrary choice, and the stable field ids state migration depends on are built ' +
            'from that order.',
          { start: found.start, end: found.end },
        );
        this.resynchronise();
        return null;
      }
    }

    if (this.expect('punct', '{', 'DS0101') === null) {
      this.resynchronise();
      return null;
    }

    const fields: FieldDecl[] = [];
    while (!this.atEnd() && !this.check('punct', '}')) {
      const field = this.parseField();
      if (field === null) break;
      fields.push(field);
      this.accept('punct', ',');
    }

    const close = this.expect('punct', '}', 'DS0102');
    if (close === null) {
      this.resynchronise();
      return { kind: 'data', name: name.text, annotations: [...annotations], base, fields, span: { start, end: name.end } };
    }

    return { kind: 'data', name: name.text, annotations: [...annotations], base, fields, span: { start, end: close.end } };
  }

  /**
   * `component Health { … }`, and `component Transform from host { … }`.
   *
   * The body is `parseField`, unchanged from `data` — a component's fields are a record's fields,
   * and giving them a second parser would be a second place a default or an `@id` could be written
   * and one of them would be wrong.
   *
   * **`from host` is two soft keywords rather than a new one.** `from` is already soft because
   * `import` needs it, and `host` is an ordinary identifier in that position, so the assertion
   * direction costs no keyword at all. What that gives up is that `host` is not reserved, so a
   * reader meets a word that is a keyword here and a variable name three lines down; what makes it
   * readable anyway is that nothing else can follow `from` in a declaration head.
   *
   * **Nothing here reserves the `$present` suffix, and nothing needs to.** An optional field is
   * stored as a value column and a `<name>$present` column beside it, so a field genuinely called
   * `of$present` would overwrite the presence of `of` in a column map. `$` is not an identifier
   * character in this language, so the lexer refuses such a name at `DS0003` before a parser ever
   * sees it — a check here would be unreachable.
   */
  private parseComponent(): ComponentDecl | null {
    const start = this.next().start;
    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0131', 'expected a name after `component`', {
        start: found.start,
        end: found.end,
      });
      this.resynchronise();
      return null;
    }

    let fromHost = false;
    if (this.accept('keyword', 'from') !== null) {
      const marker = this.acceptIdentLike();
      if (marker === null || marker.text !== 'host') {
        const found = marker ?? this.peek();
        this.report(
          'DS0131',
          '`from` in a component declaration is followed by `host`, and nothing else. It says the ' +
            'shape below is asserted about a component the host registered rather than declared ' +
            'here.',
          { start: found.start, end: found.end },
        );
        this.resynchronise();
        return null;
      }
      fromHost = true;
    }

    if (this.expect('punct', '{', 'DS0101') === null) {
      this.resynchronise();
      return null;
    }

    const fields: FieldDecl[] = [];
    while (!this.atEnd() && !this.check('punct', '}')) {
      const field = this.parseField();
      if (field === null) break;
      fields.push(field);
      this.accept('punct', ',');
    }

    const close = this.expect('punct', '}', 'DS0102');
    if (close === null) {
      this.resynchronise();
      return { kind: 'component', name: name.text, fromHost, fields, span: { start, end: name.end } };
    }
    return { kind: 'component', name: name.text, fromHost, fields, span: { start, end: close.end } };
  }

  /**
   * `entity Animal { require Transform … var target: Entity? }`.
   *
   * The body takes two line shapes and nothing else, and anything else is refused naming both —
   * a body that silently accepted a bare field would give an author a component they did not know
   * they had declared.
   *
   * **`var` and not `let`.** An entity's own fields are component state a system writes, so `let`
   * would read as immutable and not be. `parseField` is reused for what follows, so a default and
   * an `@id` mean here exactly what they mean in a record.
   */
  private parseEntity(): EntityDecl | null {
    const start = this.next().start;
    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0132', 'expected a name after `entity`', { start: found.start, end: found.end });
      this.resynchronise();
      return null;
    }
    if (this.expect('punct', '{', 'DS0101') === null) {
      this.resynchronise();
      return null;
    }

    const requires: { name: string; span: Span }[] = [];
    const fields: FieldDecl[] = [];
    while (!this.atEnd() && !this.check('punct', '}')) {
      if (this.accept('keyword', 'require') !== null) {
        const required = this.acceptIdentLike();
        if (required === null) {
          const found = this.peek();
          this.report('DS0132', 'expected a component name after `require`', {
            start: found.start,
            end: found.end,
          });
          this.resynchronise();
          return null;
        }
        requires.push({
          name: required.text,
          span: { start: required.start, end: required.end },
        });
        this.accept('punct', ',');
        continue;
      }

      if (this.accept('keyword', 'var') !== null) {
        const field = this.parseField();
        if (field === null) break;
        fields.push(field);
        this.accept('punct', ',');
        continue;
      }

      const found = this.peek();
      this.report(
        'DS0132',
        'an entity body holds `require <Component>` and `var <name>: <Type>`, and nothing else. A ' +
          'bare field here would declare a component the author did not know they had written.',
        { start: found.start, end: found.end },
      );
      this.resynchronise();
      return null;
    }

    const close = this.expect('punct', '}', 'DS0102');
    if (close === null) {
      this.resynchronise();
      return { kind: 'entity', name: name.text, requires, fields, span: { start, end: name.end } };
    }
    return { kind: 'entity', name: name.text, requires, fields, span: { start, end: close.end } };
  }

  /**
   * `system S { reads C  writes C  uses n: T  after T  update at 1Hz { … } }`.
   *
   * One `update` block, and the rate becomes a stride here — see `FIXED_STEPS_PER_SECOND`.
   *
   * **`uses` is the one clause that binds a name rather than naming a component**, so it parses a
   * name and a type where the other three parse a name alone. It is written `uses graph: NavGraph`
   * — the same `name: Type` a parameter is — because that is the shape a reader already knows for
   * "here is a value and here is what it is", and inventing a second one for the same idea is how a
   * language ends up with two spellings of a colon.
   */
  private parseSystem(annotations: readonly string[]): SystemDecl | null {
    const start = this.next().start;
    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0133', 'expected a name after `system`', { start: found.start, end: found.end });
      this.resynchronise();
      return null;
    }
    if (this.expect('punct', '{', 'DS0101') === null) {
      this.resynchronise();
      return null;
    }

    const reads: { name: string; span: Span }[] = [];
    const writes: { name: string; span: Span }[] = [];
    const after: { name: string; span: Span }[] = [];
    const uses: { name: string; type: TypeRef; span: Span }[] = [];
    let everyTicks = 1;
    let body: readonly Stmt[] | null = null;
    let updateEnd = name.end;

    const clause = (into: { name: string; span: Span }[], keyword: string): boolean => {
      const named = this.acceptIdentLike();
      if (named === null) {
        const found = this.peek();
        this.report('DS0133', `expected a name after \`${keyword}\``, {
          start: found.start,
          end: found.end,
        });
        return false;
      }
      into.push({ name: named.text, span: { start: named.start, end: named.end } });
      this.accept('punct', ',');
      return true;
    };

    while (!this.atEnd() && !this.check('punct', '}')) {
      if (this.accept('keyword', 'reads') !== null) {
        if (!clause(reads, 'reads')) { this.resynchronise(); return null; }
        continue;
      }
      if (this.accept('keyword', 'writes') !== null) {
        if (!clause(writes, 'writes')) { this.resynchronise(); return null; }
        continue;
      }
      if (this.accept('keyword', 'after') !== null) {
        if (!clause(after, 'after')) { this.resynchronise(); return null; }
        continue;
      }
      if (this.accept('keyword', 'uses') !== null) {
        const bound = this.acceptIdentLike();
        if (bound === null) {
          const found = this.peek();
          this.report('DS0133', 'expected a name after `uses`', {
            start: found.start,
            end: found.end,
          });
          this.resynchronise();
          return null;
        }
        if (this.expect('punct', ':', 'DS0103') === null) {
          this.resynchronise();
          return null;
        }
        const type = this.parseTypeRef();
        if (type === null) { this.resynchronise(); return null; }
        uses.push({ name: bound.text, type, span: { start: bound.start, end: type.span.end } });
        this.accept('punct', ',');
        continue;
      }
      if (this.check('keyword', 'update')) {
        if (body !== null) {
          const found = this.peek();
          this.report(
            'DS0133',
            'a system has one `update` block. Two would be two schedules under one name, and ' +
              '`after` addresses a system by that name.',
            { start: found.start, end: found.end },
          );
          this.resynchronise();
          return null;
        }
        this.next();
        const stride = this.parseUpdateRate();
        if (stride === null) { this.resynchronise(); return null; }
        everyTicks = stride;
        const block = this.parseBlock();
        if (block === null) { this.resynchronise(); return null; }
        body = block.stmts;
        updateEnd = block.end;
        continue;
      }

      const found = this.peek();
      this.report(
        'DS0133',
        'a system body holds `reads`, `writes`, `uses`, `after` and one `update` block, and ' +
          'nothing else.',
        { start: found.start, end: found.end },
      );
      this.resynchronise();
      return null;
    }

    const close = this.expect('punct', '}', 'DS0102');
    if (close === null) {
      this.resynchronise();
      return null;
    }

    if (body === null) {
      this.report(
        'DS0133',
        `\`${name.text}\` has no \`update\` block, so nothing about it ever runs. A system that only ` +
          'declares what it touches is a declaration with no body to check it against.',
        { start, end: close.end },
      );
      return null;
    }

    return {
      kind: 'system',
      name: name.text,
      reads,
      writes,
      uses,
      after,
      everyTicks,
      body,
      annotations: [...annotations],
      span: { start, end: close.end === 0 ? updateEnd : close.end },
    };
  }

  /**
   * `update` or `update at <rate>Hz`, as a stride over fixed steps.
   *
   * **A rate that is not a whole number of fixed steps is refused naming the arithmetic.** `7Hz` is
   * 8.57 steps; rounding it silently is how a replay stops matching a recording, which is the whole
   * reason the entity model refused a rate in seconds and made its parameter a stride.
   */
  private parseUpdateRate(): number | null {
    if (this.accept('keyword', 'at') === null) return 1;

    const value = this.peek();
    if (value.kind !== 'number') {
      this.report('DS0133', '`update at` is followed by a rate, as in `update at 1Hz`', {
        start: value.start,
        end: value.end,
      });
      return null;
    }
    this.next();
    const unit = this.peek();
    if (unit.kind !== 'unit' || unit.text !== 'Hz') {
      this.report(
        'DS0133',
        'a system rate is written in `Hz`. Seconds would be a wall-clock rate, and two runs of one ' +
          'recording would then run the system a different number of times.',
        { start: unit.start, end: unit.end },
      );
      return null;
    }
    this.next();

    const rate = Number(value.text);
    const perSecond = this.fixedStepsPerSecond;
    const stride = perSecond / rate;
    if (!Number.isFinite(stride) || stride <= 0 || !Number.isInteger(stride)) {
      this.report(
        'DS0133',
        `\`${value.text}Hz\` is ${stride.toFixed(2)} fixed steps, which is not a whole stride. ` +
          `This target's fixed step is 1/${perSecond}, so a rate has to divide it exactly: ` +
          `${ratesDividing(perSecond).join(', ')}Hz.`,
        { start: value.start, end: unit.end },
      );
      return null;
    }
    return stride;
  }

  /**
   * `prefab Guard { Transform {} Health { current: 100 } }`.
   *
   * **An empty brace pair is the common case, not a degenerate one.** A marker component carries no
   * fields at all, and requiring a value list would make the most-used shape the one that needs a
   * workaround.
   */
  private parsePrefab(): PrefabDecl | null {
    const start = this.next().start;
    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0134', 'expected a name after `prefab`', { start: found.start, end: found.end });
      this.resynchronise();
      return null;
    }
    if (this.expect('punct', '{', 'DS0101') === null) {
      this.resynchronise();
      return null;
    }

    const components: PrefabDecl['components'][number][] = [];
    while (!this.atEnd() && !this.check('punct', '}')) {
      const component = this.acceptIdentLike();
      if (component === null) {
        const found = this.peek();
        this.report(
          'DS0134',
          'a prefab body names a component and then its values, as in `Health { current: 100 }`.',
          { start: found.start, end: found.end },
        );
        this.resynchronise();
        return null;
      }
      if (this.expect('punct', '{', 'DS0101') === null) {
        this.resynchronise();
        return null;
      }

      const values: { name: string; value: Expr; span: Span }[] = [];
      while (!this.atEnd() && !this.check('punct', '}')) {
        const field = this.acceptIdentLike();
        if (field === null) {
          const found = this.peek();
          this.report('DS0134', 'expected a field name', { start: found.start, end: found.end });
          this.resynchronise();
          return null;
        }
        if (this.expect('punct', ':', 'DS0106') === null) {
          this.resynchronise();
          return null;
        }
        const value = this.parseExpr();
        if (value === null) {
          this.resynchronise();
          return null;
        }
        values.push({ name: field.text, value, span: { start: field.start, end: value.span.end } });
        this.accept('punct', ',');
      }

      const componentClose = this.expect('punct', '}', 'DS0102');
      if (componentClose === null) {
        this.resynchronise();
        return null;
      }
      components.push({
        name: component.text,
        values,
        span: { start: component.start, end: componentClose.end },
      });
      this.accept('punct', ',');
    }

    const close = this.expect('punct', '}', 'DS0102');
    if (close === null) {
      this.resynchronise();
      return null;
    }
    return { kind: 'prefab', name: name.text, components, span: { start, end: close.end } };
  }

  private parseEnum(): EnumDecl | null {
    const start = this.next().start;
    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0116', 'expected a name after `enum`', { start: found.start, end: found.end });
      this.resynchronise();
      return null;
    }
    if (this.expect('punct', '{', 'DS0101') === null) {
      this.resynchronise();
      return null;
    }

    const variants: EnumVariant[] = [];
    while (!this.atEnd() && !this.check('punct', '}')) {
      const variant = this.acceptIdentLike();
      if (variant === null) {
        const found = this.peek();
        this.report('DS0117', 'expected a variant name', { start: found.start, end: found.end });
        break;
      }
      let payload: TypeRef | undefined;
      let end = variant.end;
      if (this.accept('punct', '(') !== null) {
        const parsed = this.parseTypeRef();
        if (parsed === null) break;
        payload = parsed;
        const close = this.expect('punct', ')', 'DS0110');
        if (close === null) break;
        end = close.end;
      }
      variants.push({ name: variant.text, payload, span: { start: variant.start, end } });
      this.accept('punct', ',');
    }

    const close = this.expect('punct', '}', 'DS0102');
    if (close === null) {
      this.resynchronise();
      return { kind: 'enum', name: name.text, variants, span: { start, end: name.end } };
    }
    return { kind: 'enum', name: name.text, variants, span: { start, end: close.end } };
  }

  private parseField(): FieldDecl | null {
    /*
     * `@id("phase")` before the field, and it is the only annotation a field takes.
     *
     * Refusing the others by name rather than ignoring them: an annotation the parser silently drops
     * is one an author believes is doing something.
     */
    let pinned: string | undefined;
    let editor: EditorMeta | undefined;
    while (this.check('annotation')) {
      const at = this.next();
      if (at.text === '@editor') {
        const parsed = this.parseEditor(at.start);
        if (parsed === null) return null;
        editor = parsed;
        continue;
      }
      if (at.text !== '@id') {
        this.report(
          'DS0130',
          `\`${at.text}\` is not an annotation a field takes; \`@id\` and \`@editor\` are`,
          { start: at.start, end: at.end },
        );
        return null;
      }
      if (this.expect('punct', '(', 'DS0109') === null) return null;
      const literal = this.peek();
      if (literal.kind !== 'string') {
        this.report('DS0130', '`@id` takes the field name it keeps, in quotes', {
          start: literal.start,
          end: literal.end,
        });
        return null;
      }
      this.next();
      if (this.expect('punct', ')', 'DS0110') === null) return null;
      pinned = literal.text.slice(1, -1);
    }

    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0106', 'expected a field name', { start: found.start, end: found.end });
      return null;
    }
    if (this.expect('punct', ':', 'DS0107') === null) return null;

    const type = this.parseTypeRef();
    if (type === null) return null;

    let value: Expr | undefined;
    let end = type.span.end;
    if (this.accept('punct', '=') !== null) {
      const parsed = this.parseExpr();
      if (parsed === null) return null;
      value = parsed;
      end = parsed.span.end;
    }

    return {
      name: name.text,
      id: pinned,
      type,
      default: value,
      editor,
      span: { start: name.start, end },
    };
  }

  /**
   * `@editor(label: "…", category: "…", range: 1m..150m, assetType: "…")`.
   *
   * Every key is optional and order does not matter, because this is a description rather than a
   * signature. A key that is not one of the four is refused naming all four: an annotation the
   * parser silently drops is one an author believes is doing something, which is the rule `@id`
   * already follows two lines up.
   */
  private parseEditor(start: number): EditorMeta | null {
    if (this.expect('punct', '(', 'DS0109') === null) return null;

    let label: string | undefined;
    let category: string | undefined;
    let range: EditorMeta['range'];
    let assetType: EditorMeta['assetType'];

    const stringValue = (key: string): string | null => {
      const literal = this.peek();
      if (literal.kind !== 'string') {
        this.report('DS0136', `\`${key}\` takes text in quotes`, {
          start: literal.start,
          end: literal.end,
        });
        return null;
      }
      this.next();
      return literal.text.slice(1, -1);
    };

    while (!this.atEnd() && !this.check('punct', ')')) {
      const key = this.acceptIdentLike();
      if (key === null) {
        const found = this.peek();
        this.report(
          'DS0136',
          '`@editor` takes `label`, `category`, `range` and `assetType`, in any order',
          { start: found.start, end: found.end },
        );
        return null;
      }
      if (this.expect('punct', ':', 'DS0107') === null) return null;

      if (key.text === 'label') {
        const parsed = stringValue('label');
        if (parsed === null) return null;
        label = parsed;
      } else if (key.text === 'category') {
        const parsed = stringValue('category');
        if (parsed === null) return null;
        category = parsed;
      } else if (key.text === 'assetType') {
        const literal = this.peek();
        const parsed = stringValue('assetType');
        if (parsed === null) return null;
        assetType = { name: parsed, span: { start: literal.start, end: literal.end } };
      } else if (key.text === 'range') {
        const parsed = this.parseEditorRange();
        if (parsed === null) return null;
        range = parsed;
      } else {
        this.report(
          'DS0136',
          `\`${key.text}\` is not an \`@editor\` key; \`label\`, \`category\`, \`range\` and ` +
            '`assetType` are',
          { start: key.start, end: key.end },
        );
        return null;
      }
      this.accept('punct', ',');
    }

    const close = this.expect('punct', ')', 'DS0110');
    if (close === null) return null;
    return { label, category, range, assetType, span: { start, end: close.end } };
  }

  /**
   * `1m..150m` — two numbers with an optional unit, and the unit has to be the same on both.
   *
   * A range written `1m..150s` describes nothing, and the two halves are the only place a reader
   * could see it. Checking it here rather than in the checker keeps the message beside what
   * somebody wrote.
   */
  private parseEditorRange(): EditorMeta['range'] {
    const readBound = (): { value: number; unit?: string; start: number; end: number } | null => {
      const number = this.peek();
      if (number.kind !== 'number') {
        this.report('DS0136', '`range` takes two numbers, as in `1..10` or `1m..150m`', {
          start: number.start,
          end: number.end,
        });
        return null;
      }
      this.next();
      const unit = this.check('unit') ? this.next() : null;
      return {
        value: Number(number.text),
        unit: unit?.text,
        start: number.start,
        end: unit?.end ?? number.end,
      };
    };

    const min = readBound();
    if (min === null) return undefined;
    if (this.expect('punct', '..', 'DS0136') === null) return undefined;
    const max = readBound();
    if (max === null) return undefined;

    if (min.unit !== max.unit) {
      this.report(
        'DS0136',
        `a range's two bounds carry different units — \`${min.unit ?? 'none'}\` and ` +
          `\`${max.unit ?? 'none'}\`. A range between two different quantities describes nothing.`,
        { start: min.start, end: max.end },
      );
      return undefined;
    }

    return { min: min.value, max: max.value, unit: min.unit, span: { start: min.start, end: max.end } };
  }

  /**
   * `(key: "value", key: "value")` after an annotation name.
   *
   * Values are string literals only. An annotation is an assertion the compiler checks,
   * and an expression here would make it a computation the compiler has to run — which
   * is a much larger thing than the two descriptions this exists for.
   */
  private parseAnnotationArgs(annotation: string, out: Map<string, string>): void {
    this.expect('punct', '(', 'DS0131');
    while (!this.check('punct', ')') && !this.atEnd()) {
      const key = this.accept('ident');
      if (key === null) {
        this.report('DS0131', 'expected an annotation argument name', this.spanHere());
        break;
      }
      if (this.expect('punct', ':', 'DS0131') === null) break;
      const value = this.accept('string');
      if (value === null) {
        this.report(
          'DS0132',
          `\`${annotation}\` argument \`${key.text}\` needs a string literal — an annotation is ` +
            'an assertion the compiler checks, and an expression here would make it a computation ' +
            'the compiler has to run',
          this.spanHere(),
        );
        break;
      }
      out.set(`${annotation}.${key.text}`, literalText(value.text));
      if (!this.check('punct', ')')) {
        if (this.expect('punct', ',', 'DS0131') === null) break;
      }
    }
    this.expect('punct', ')', 'DS0131');
  }

  private spanHere(): { start: number; end: number } {
    const found = this.peek();
    return { start: found.start, end: found.end };
  }

  private parseFn(
    annotations: readonly string[],
    annotationArgs: ReadonlyMap<string, string> = new Map(),
  ): FnDecl | null {
    const start = this.next().start;
    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0108', 'expected a name after `fn`', { start: found.start, end: found.end });
      this.resynchronise();
      return null;
    }
    if (this.expect('punct', '(', 'DS0109') === null) {
      this.resynchronise();
      return null;
    }

    const params: ParamDecl[] = [];
    let malformed = false;
    while (!this.atEnd() && !this.check('punct', ')')) {
      const param = this.parseParam();
      if (param === null) {
        malformed = true;
        break;
      }
      params.push(param);
      if (this.accept('punct', ',') === null) break;
    }

    if (malformed || this.expect('punct', ')', 'DS0110') === null) {
      this.resynchronise();
      return null;
    }

    let returnType: TypeRef | undefined;
    if (this.accept('punct', '->') !== null) {
      const parsed = this.parseTypeRef();
      if (parsed === null) {
        this.resynchronise();
        return null;
      }
      returnType = parsed;
    }

    const body = this.parseBlock();
    if (body === null) {
      this.resynchronise();
      return null;
    }

    return {
      kind: 'fn',
      name: name.text,
      annotations,
      annotationArgs,
      params,
      returnType,
      body: body.stmts,
      span: { start, end: body.end },
    };
  }

  /**
   * `task name(params) { … }`.
   *
   * The parameter list is parsed by the same routine `fn` uses, because a task's parameters mean
   * the same thing — they differ only in where they live once it is running, which is a decision
   * for the emitter rather than for the grammar.
   *
   * There is no return type, and the absence is not an omission the grammar is being lenient
   * about: a task finishes at a moment nobody is waiting at, so there is nowhere for a value to go.
   */
  private parseTask(annotations: readonly string[]): TaskDecl | null {
    const start = this.next().start;
    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0108', 'expected a name after `task`', { start: found.start, end: found.end });
      this.resynchronise();
      return null;
    }
    if (this.expect('punct', '(', 'DS0109') === null) {
      this.resynchronise();
      return null;
    }

    const params: ParamDecl[] = [];
    let malformed = false;
    while (!this.atEnd() && !this.check('punct', ')')) {
      const param = this.parseParam();
      if (param === null) {
        malformed = true;
        break;
      }
      params.push(param);
      if (this.accept('punct', ',') === null) break;
    }

    if (malformed || this.expect('punct', ')', 'DS0110') === null) {
      this.resynchronise();
      return null;
    }

    if (this.check('punct', '->')) {
      const found = this.peek();
      this.report('DS0126', 'a task has no return type: it finishes where nobody is waiting', {
        start: found.start,
        end: found.end,
      });
      this.resynchronise();
      return null;
    }

    const body = this.parseBlock();
    if (body === null) {
      this.resynchronise();
      return null;
    }

    return {
      kind: 'task',
      name: name.text,
      annotations,
      params,
      body: body.stmts,
      span: { start, end: body.end },
    };
  }

  /**
   * `await fixedTime(500ms)` or `await settle()`.
   *
   * One of the three clock names is a duration; anything else is a task. Decided here rather than
   * by the checker because the two suspend on different things and produce different nodes — and
   * because "is this one of three names" is a fact the parser already has.
   */
  private parseAwait(): Stmt | null {
    const start = this.next().start;
    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0125', 'expected a clock or a task name after `await`', {
        start: found.start,
        end: found.end,
      });
      return null;
    }

    if (this.expect('punct', '(', 'DS0109') === null) return null;

    const clock = CLOCK_NAMES[name.text];
    if (clock !== undefined) {
      const duration = this.parseExpr();
      if (duration === null) return null;
      const close = this.expect('punct', ')', 'DS0110');
      if (close === null) return null;
      return { kind: 'await', clock, duration, span: { start, end: close.end } };
    }

    const args: Expr[] = [];
    while (!this.atEnd() && !this.check('punct', ')')) {
      const arg = this.parseExpr();
      if (arg === null) return null;
      args.push(arg);
      if (this.accept('punct', ',') === null) break;
    }
    const close = this.expect('punct', ')', 'DS0110');
    if (close === null) return null;
    return { kind: 'awaitTask', task: name.text, args, span: { start, end: close.end } };
  }

  /** `state Closed { enter { … } on Open { … } }`. */
  private parseState(): StateDecl | null {
    const start = this.next().start;
    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0129', 'expected a name after `state`', { start: found.start, end: found.end });
      this.resynchronise();
      return null;
    }
    if (this.expect('punct', '{', 'DS0101') === null) {
      this.resynchronise();
      return null;
    }

    let enter: readonly Stmt[] | undefined;
    const handlers: { event: string; binding?: string; body: readonly Stmt[]; span: Span }[] = [];

    while (!this.atEnd() && !this.check('punct', '}')) {
      if (this.check('keyword', 'enter')) {
        const at = this.next();
        if (enter !== undefined) {
          this.report('DS0129', `\`${name.text}\` declares \`enter\` more than once`, {
            start: at.start,
            end: at.end,
          });
        }
        const body = this.parseBlock();
        if (body === null) {
          this.resynchronise();
          return null;
        }
        enter = body.stmts;
        continue;
      }

      if (this.check('keyword', 'on')) {
        const at = this.next();
        const event = this.acceptIdentLike();
        if (event === null) {
          const found = this.peek();
          this.report('DS0129', 'expected an event name after `on`', {
            start: found.start,
            end: found.end,
          });
          this.resynchronise();
          return null;
        }
        let binding: string | undefined;
        if (this.accept('keyword', 'as') !== null) {
          const name = this.acceptIdentLike();
          if (name === null) {
            const found = this.peek();
            this.report('DS0128', 'expected a name for the payload after `as`', {
              start: found.start,
              end: found.end,
            });
            this.resynchronise();
            return null;
          }
          binding = name.text;
        }

        const body = this.parseBlock();
        if (body === null) {
          this.resynchronise();
          return null;
        }
        handlers.push({
          event: event.text,
          binding,
          body: body.stmts,
          span: { start: at.start, end: body.end },
        });
        continue;
      }

      const found = this.peek();
      this.report('DS0129', `expected \`enter\` or \`on\` but found \`${found.text}\``, {
        start: found.start,
        end: found.end,
      });
      this.resynchronise();
      return null;
    }

    const close = this.expect('punct', '}', 'DS0102');
    if (close === null) {
      this.resynchronise();
      return null;
    }
    return { kind: 'state', name: name.text, enter, handlers, span: { start, end: close.end } };
  }

  /** `event Alarm { source: Node, strength: f32 }`. */
  private parseEvent(): EventDecl | null {
    const start = this.next().start;
    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0127', 'expected a name after `event`', { start: found.start, end: found.end });
      this.resynchronise();
      return null;
    }
    if (this.expect('punct', '{', 'DS0101') === null) {
      this.resynchronise();
      return null;
    }

    const fields: FieldDecl[] = [];
    while (!this.atEnd() && !this.check('punct', '}')) {
      const field = this.parseField();
      if (field === null) {
        this.resynchronise();
        return null;
      }
      fields.push(field);
      this.accept('punct', ',');
    }

    const close = this.expect('punct', '}', 'DS0102');
    if (close === null) {
      this.resynchronise();
      return null;
    }
    return { kind: 'event', name: name.text, fields, span: { start, end: close.end } };
  }

  /** `on Alarm as alarm { … }`. */
  private parseOn(): OnDecl | null {
    const start = this.next().start;
    const event = this.acceptIdentLike();
    if (event === null) {
      const found = this.peek();
      this.report('DS0127', 'expected an event name after `on`', {
        start: found.start,
        end: found.end,
      });
      this.resynchronise();
      return null;
    }
    if (this.expect('keyword', 'as', 'DS0128') === null) {
      this.resynchronise();
      return null;
    }
    const binding = this.acceptIdentLike();
    if (binding === null) {
      const found = this.peek();
      this.report('DS0128', 'expected a name for the payload after `as`', {
        start: found.start,
        end: found.end,
      });
      this.resynchronise();
      return null;
    }
    const body = this.parseBlock();
    if (body === null) {
      this.resynchronise();
      return null;
    }
    return {
      kind: 'on',
      event: event.text,
      binding: binding.text,
      body: body.stmts,
      span: { start, end: body.end },
    };
  }

  /** `emit Alarm { strength: 0.8 }`. */
  private parseEmit(): Stmt | null {
    const start = this.next().start;
    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0127', 'expected an event name after `emit`', {
        start: found.start,
        end: found.end,
      });
      return null;
    }
    if (this.expect('punct', '{', 'DS0101') === null) return null;

    const fields: { name: string; value: Expr; span: Span }[] = [];
    while (!this.atEnd() && !this.check('punct', '}')) {
      const field = this.acceptIdentLike();
      if (field === null) {
        const found = this.peek();
        this.report('DS0127', 'expected a field name', { start: found.start, end: found.end });
        return null;
      }
      if (this.expect('punct', ':', 'DS0106') === null) return null;
      const value = this.parseExpr();
      if (value === null) return null;
      fields.push({ name: field.text, value, span: { start: field.start, end: value.span.end } });
      this.accept('punct', ',');
    }

    const close = this.expect('punct', '}', 'DS0102');
    if (close === null) return null;
    return { kind: 'emit', event: name.text, fields, span: { start, end: close.end } };
  }

  /** `spawn pulse(a, b)`. */
  private parseSpawn(): Stmt | null {
    const start = this.next().start;
    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0108', 'expected a task name after `spawn`', {
        start: found.start,
        end: found.end,
      });
      return null;
    }
    if (this.expect('punct', '(', 'DS0109') === null) return null;

    const args: Expr[] = [];
    while (!this.atEnd() && !this.check('punct', ')')) {
      const arg = this.parseExpr();
      if (arg === null) return null;
      args.push(arg);
      if (this.accept('punct', ',') === null) break;
    }
    const close = this.expect('punct', ')', 'DS0110');
    if (close === null) return null;

    return { kind: 'spawn', task: name.text, args, span: { start, end: close.end } };
  }

  /** `scope effect { … }`. */
  private parseScope(): Stmt | null {
    const start = this.next().start;
    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0108', 'expected a name after `scope`', { start: found.start, end: found.end });
      return null;
    }
    const body = this.parseBlock();
    if (body === null) return null;
    return { kind: 'scope', name: name.text, body: body.stmts, span: { start, end: body.end } };
  }

  private parseParam(): ParamDecl | null {
    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0111', 'expected a parameter name', { start: found.start, end: found.end });
      return null;
    }
    if (this.expect('punct', ':', 'DS0107') === null) return null;

    const mutable = this.accept('keyword', 'mut') !== null;
    const type = this.parseTypeRef();
    if (type === null) return null;

    return { name: name.text, type, mutable, span: { start: name.start, end: type.span.end } };
  }

  private parseTypeRef(): TypeRef | null {
    const token = this.peek();
    let base: TypeRef;

    if (token.kind === 'keyword' && isPrimitive(token.text)) {
      this.next();
      const args = this.parseTypeArgs();
      base = {
        kind: 'primitive',
        name: token.text,
        args,
        span: { start: token.start, end: this.peek(-1).end },
      };
    } else if (token.kind === 'ident' || (token.kind === 'keyword' && isSoftKeyword(token.text))) {
      this.next();
      const args = this.parseTypeArgs();
      base = {
        kind: 'named',
        name: token.text,
        args,
        span: { start: token.start, end: this.peek(-1).end },
      };
    } else {
      this.report('DS0112', `expected a type but found \`${token.text}\``, {
        start: token.start,
        end: token.end,
      });
      return null;
    }

    /* `T?` is postfix and may stack, so `T??` is an option of an option. That is legal rather than
       merely tolerated: an option-returning lookup over an option-valued field is a real shape, and
       flattening it silently is what makes `null` ambiguous in the languages that do. */
    while (this.check('punct', '?')) {
      const mark = this.next();
      base = { kind: 'option', inner: base, span: { start: base.span.start, end: mark.end } };
    }
    return base;
  }

  private parseTypeArgs(): readonly TypeRef[] {
    if (!this.check('punct', '<')) return [];
    this.next();
    const args: TypeRef[] = [];
    while (!this.atEnd() && !this.check('punct', '>')) {
      const arg = this.parseTypeRef();
      if (arg === null) break;
      args.push(arg);
      if (this.accept('punct', ',') === null) break;
    }
    this.expect('punct', '>', 'DS0118');
    return args;
  }

  private parseBlock(): { stmts: Stmt[]; end: number } | null {
    if (this.expect('punct', '{', 'DS0101') === null) return null;

    const stmts: Stmt[] = [];
    while (!this.atEnd() && !this.check('punct', '}')) {
      const before = this.at;
      const stmt = this.parseStmt();
      if (stmt !== null) stmts.push(stmt);
      if (this.at === before) this.next();
    }

    const close = this.expect('punct', '}', 'DS0102');
    if (close === null) return null;
    return { stmts, end: close.end };
  }

  private parseStmt(): Stmt | null {
    const token = this.peek();

    if (token.kind === 'keyword' && (token.text === 'let' || token.text === 'var')) {
      return this.parseLet(token.text === 'var');
    }
    if (token.kind === 'keyword' && token.text === 'return') return this.parseReturn();
    if (token.kind === 'keyword' && (token.text === 'break' || token.text === 'continue')) {
      /* No label and no value. A labelled break needs a name on the loop, and nothing has asked for
         one; adding it later is a change to this line and to the checker's loop stack, which is why
         the node carries a word instead of two kinds. */
      this.next();
      return {
        kind: 'loopJump',
        word: token.text,
        span: { start: token.start, end: token.end },
      };
    }
    if (token.kind === 'keyword' && token.text === 'if') return this.parseIf();
    if (token.kind === 'keyword' && token.text === 'while') return this.parseWhile();
    if (token.kind === 'keyword' && token.text === 'for') return this.parseForQuery();
    if (token.kind === 'keyword' && token.text === 'await') return this.parseAwait();
    if (token.kind === 'keyword' && token.text === 'spawn') return this.parseSpawn();
    if (token.kind === 'keyword' && token.text === 'become' && this.peek(1).kind === 'ident') {
      const start = this.next().start;
      const name = this.next();
      return { kind: 'become', state: name.text, span: { start, end: name.end } };
    }
    /* Like `scope`, `emit` is a soft keyword: a leading one is a statement only when a name
       follows. `emit.field` and `emit = 1` fall through to an ordinary expression. */
    if (token.kind === 'keyword' && token.text === 'emit' && this.peek(1).kind === 'ident') {
      return this.parseEmit();
    }
    /* `scope` is a soft keyword, so a leading one is a block only when a name follows it. Anything
       else — `scope.field`, `scope = 1` — is an ordinary expression and falls through. */
    if (token.kind === 'keyword' && token.text === 'scope' && this.peek(1).kind === 'ident') {
      return this.parseScope();
    }

    const target = this.parseExpr();
    if (target === null) return null;

    const op = this.peek();
    if (op.kind === 'punct' && COMPOUND_OPS.has(op.text)) {
      this.next();
      const value = this.parseExpr();
      if (value === null) return null;
      return {
        kind: 'compoundAssign',
        target,
        op: op.text,
        value,
        span: { start: target.span.start, end: value.span.end },
      };
    }
    if (op.kind === 'punct' && op.text === '=') {
      this.next();
      const value = this.parseExpr();
      if (value === null) return null;
      return {
        kind: 'assign',
        target,
        value,
        span: { start: target.span.start, end: value.span.end },
      };
    }

    return { kind: 'expr', expr: target, span: target.span };
  }

  /**
   * `let NAME = value` or `let NAME: Type = value`, at the top of a file.
   *
   * Shares nothing with `parseLet` beyond its shape, because the two produce different nodes and the
   * refusal below belongs only to this one: a **`var` here is reported rather than parsed**, and
   * reported in words that say what is wrong with it. Falling through to "expected a declaration"
   * would have named the keyword and not the reason, and the reason is the whole point — module
   * state is what a hot reload has to migrate and a replay has to restore.
   */
  private parseModuleConst(): Decl | null {
    const keyword = this.peek();
    const start = this.next().start;

    if (keyword.text === 'var') {
      this.report(
        'DS0137',
        'a module-level binding is always `let`. `var` here would be state the whole file can ' +
          'write, which a hot reload has to migrate and a replay has to restore.',
        { start: keyword.start, end: keyword.end },
      );
      this.resynchronise();
      return null;
    }

    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0119', 'expected a name after `let`', { start: found.start, end: found.end });
      this.resynchronise();
      return null;
    }

    let type: TypeRef | undefined;
    if (this.accept('punct', ':') !== null) {
      const parsed = this.parseTypeRef();
      if (parsed === null) {
        this.resynchronise();
        return null;
      }
      type = parsed;
    }

    if (this.expect('punct', '=', 'DS0120') === null) {
      this.resynchronise();
      return null;
    }
    const value = this.parseExpr();
    if (value === null) {
      this.resynchronise();
      return null;
    }

    return { kind: 'const', name: name.text, type, value, span: { start, end: value.span.end } };
  }

  private parseLet(mutable: boolean): Stmt | null {
    const start = this.next().start;
    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0119', 'expected a name after `let` or `var`', {
        start: found.start,
        end: found.end,
      });
      return null;
    }

    let type: TypeRef | undefined;
    if (this.accept('punct', ':') !== null) {
      const parsed = this.parseTypeRef();
      if (parsed === null) return null;
      type = parsed;
    }

    if (this.expect('punct', '=', 'DS0120') === null) return null;
    const value = this.parseExpr();
    if (value === null) return null;

    return {
      kind: 'let',
      name: name.text,
      mutable,
      type,
      value,
      span: { start, end: value.span.end },
    };
  }

  private parseReturn(): Stmt | null {
    const token = this.next();
    /* A bare `return` ends at the line or the block. Reading past a newline would make a `return`
       followed by a statement swallow that statement as the returned value. */
    if (this.check('punct', '}') || this.startsNewLine()) {
      return { kind: 'return', span: { start: token.start, end: token.end } };
    }
    const value = this.parseExpr();
    if (value === null) return null;
    return { kind: 'return', value, span: { start: token.start, end: value.span.end } };
  }

  private parseIf(): Stmt | null {
    const start = this.next().start;

    /* `if let name = subject { … }` binds an option's contents, and is checked before the ordinary
       condition because `let` is a keyword and would otherwise parse as an expression and fail. */
    if (this.check('keyword', 'let')) {
      this.next();
      const name = this.acceptIdentLike();
      if (name === null) {
        const found = this.peek();
        this.report('DS0121', 'expected a name after `if let`', {
          start: found.start,
          end: found.end,
        });
        return null;
      }
      if (this.expect('punct', '=', 'DS0120') === null) return null;
      const subject = this.parseCondition();
      if (subject === null) return null;
      const then = this.parseBlock();
      if (then === null) return null;
      const otherwise = this.parseElse();
      return {
        kind: 'ifLet',
        name: name.text,
        subject,
        then: then.stmts,
        otherwise: otherwise?.stmts,
        span: { start, end: otherwise?.end ?? then.end },
      };
    }

    const condition = this.parseCondition();
    if (condition === null) return null;
    const then = this.parseBlock();
    if (then === null) return null;
    const otherwise = this.parseElse();
    return {
      kind: 'if',
      condition,
      then: then.stmts,
      otherwise: otherwise?.stmts,
      span: { start, end: otherwise?.end ?? then.end },
    };
  }

  private parseElse(): { stmts: Stmt[]; end: number } | null {
    if (this.accept('keyword', 'else') === null) return null;
    /* `else if` chains by parsing the `if` as the single statement of the else block, which keeps
       the tree shape uniform — every `otherwise` is a list of statements. */
    if (this.check('keyword', 'if')) {
      const nested = this.parseIf();
      if (nested === null) return null;
      return { stmts: [nested], end: nested.span.end };
    }
    return this.parseBlock();
  }

  /**
   * `for e in query<A, B>().with<C>().without<D>() { … }`.
   *
   * The only loop over anything this language has: `while` was the only loop at all, and `for` and
   * `in` had been reserved words with no form. The subject is a query and nothing else, which is
   * the rule that makes the rest of this parse — see `parseQuerySpec`.
   */
  private parseForQuery(): Stmt | null {
    const start = this.next().start;
    const binding = this.acceptIdentLike();
    if (binding === null) {
      const found = this.peek();
      this.report('DS0135', 'expected a name after `for`, to bind each entity the query yields', {
        start: found.start,
        end: found.end,
      });
      this.resynchronise();
      return null;
    }
    if (this.expect('keyword', 'in', 'DS0135') === null) {
      this.resynchronise();
      return null;
    }
    /*
     * `for x in query<…>()` and `for x in xs` share a keyword and nothing else.
     *
     * Told apart by the word after `in`, which is the only place they can differ: `query` is a
     * keyword, so no expression can begin with it and the test cannot misread a list whose variable
     * happens to be called that. Anything else is an expression yielding a list.
     */
    if (!this.check('keyword', 'query')) {
      /* Through `parseCondition`, which is what suppresses a record literal: `for x in xs {` puts a
         brace on the same line as an identifier, which is exactly the record-literal shape, and
         without this the loop's own body was parsed as `xs { … }`. The same resolution `if` and
         `while` already take, and a subject that genuinely is a record literal parenthesises it. */
      const subject = this.parseCondition();
      if (subject === null) {
        this.resynchronise();
        return null;
      }
      const listBody = this.parseBlock();
      if (listBody === null) return null;
      return {
        kind: 'forList',
        binding: binding.text,
        subject,
        body: listBody.stmts,
        span: { start, end: listBody.end },
      };
    }

    const query = this.parseQuerySpec();
    if (query === null) {
      this.resynchronise();
      return null;
    }
    const body = this.parseBlock();
    if (body === null) return null;
    return {
      kind: 'forQuery',
      binding: binding.text,
      query,
      body: body.stmts,
      span: { start, end: body.end },
    };
  }

  /**
   * `query<A, B>()`, then any number of `.with<C>()` and `.without<D>()`.
   *
   * **Entered only from `parseForQuery`, which is the whole reason this parses at all.** Type
   * arguments at a call site sit where `<` is otherwise a comparison; because this is reachable
   * only after `in`, every `<` from here to the closing `)` is unambiguously a type argument, and
   * the parser never needs to know what `.with` is a member of. Reading a query anywhere an
   * expression may appear would need exactly that, which is checker knowledge.
   */
  private parseQuerySpec(): QuerySpec | null {
    const head = this.peek();
    if (this.expect('keyword', 'query', 'DS0135') === null) return null;

    const required = this.parseTypeArgs();
    if (required.length === 0) {
      this.report(
        'DS0135',
        '`query` takes at least one component, as in `query<Transform>()`. A query over nothing ' +
          'would yield every entity in the world and say it had been narrowed.',
        { start: head.start, end: this.peek(-1).end },
      );
      return null;
    }
    if (this.expect('punct', '(', 'DS0109') === null) return null;
    if (this.expect('punct', ')', 'DS0110') === null) return null;

    const withTypes: TypeRef[] = [];
    const withoutTypes: TypeRef[] = [];
    let end = this.peek(-1).end;

    while (this.check('punct', '.')) {
      this.next();
      const filter = this.peek();
      const isWith = filter.kind === 'ident' && filter.text === 'with';
      const isWithout = filter.kind === 'ident' && filter.text === 'without';
      if (!isWith && !isWithout) {
        this.report(
          'DS0135',
          'a query takes `.with<T>()` and `.without<T>()`, and nothing else. It is not a value, so ' +
            'there is nothing else to call on one.',
          { start: filter.start, end: filter.end },
        );
        return null;
      }
      this.next();
      const args = this.parseTypeArgs();
      if (args.length !== 1) {
        this.report('DS0135', `\`${filter.text}\` takes exactly one component`, {
          start: filter.start,
          end: this.peek(-1).end,
        });
        return null;
      }
      if (this.expect('punct', '(', 'DS0109') === null) return null;
      const close = this.expect('punct', ')', 'DS0110');
      if (close === null) return null;
      (isWith ? withTypes : withoutTypes).push(args[0] as TypeRef);
      end = close.end;
    }

    return {
      required,
      with: withTypes,
      without: withoutTypes,
      span: { start: head.start, end },
    };
  }

  private parseWhile(): Stmt | null {
    const start = this.next().start;
    const condition = this.parseCondition();
    if (condition === null) return null;
    const body = this.parseBlock();
    if (body === null) return null;
    return { kind: 'while', condition, body: body.stmts, span: { start, end: body.end } };
  }

  parseExpr(): Expr | null {
    return this.parseBinary(0);
  }

  private parseBinary(level: number): Expr | null {
    if (level >= PRECEDENCE.length) return this.parseUnary();

    let left = this.parseBinary(level + 1);
    if (left === null) return null;

    for (;;) {
      const op = this.peek();
      if (op.kind !== 'punct' || !PRECEDENCE[level].includes(op.text)) return left;
      this.next();
      const right = this.parseBinary(level + 1);
      if (right === null) return null;
      left = {
        kind: 'binary',
        op: op.text,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
    }
  }

  private parseUnary(): Expr | null {
    const token = this.peek();
    if (token.kind === 'punct' && UNARY_OPS.has(token.text)) {
      this.next();
      const operand = this.parseUnary();
      if (operand === null) return null;
      return {
        kind: 'unary',
        op: token.text,
        operand,
        span: { start: token.start, end: operand.span.end },
      };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr | null {
    let expr = this.parsePrimary();
    if (expr === null) return null;

    for (;;) {
      if (this.accept('punct', '.') !== null) {
        const name = this.acceptIdentLike();
        if (name === null) {
          const found = this.peek();
          this.report('DS0114', 'expected a field name after `.`', {
            start: found.start,
            end: found.end,
          });
          return null;
        }
        expr = {
          kind: 'member',
          target: expr,
          name: name.text,
          span: { start: expr.span.start, end: name.end },
        };
        continue;
      }

      if (this.accept('punct', '?.') !== null) {
        const name = this.acceptIdentLike();
        if (name === null) {
          const found = this.peek();
          this.report('DS0114', 'expected a field name after `?.`', {
            start: found.start,
            end: found.end,
          });
          return null;
        }
        expr = {
          kind: 'optionalMember',
          target: expr,
          name: name.text,
          span: { start: expr.span.start, end: name.end },
        };
        continue;
      }

      if (this.check('punct', '[')) {
        this.next();
        const at = this.parseExpr();
        if (at === null) return null;
        const close = this.expect('punct', ']', 'DS0110');
        if (close === null) return null;
        expr = { kind: 'index', target: expr, at, span: { start: expr.span.start, end: close.end } };
        continue;
      }

      if (this.check('punct', '(')) {
        this.next();
        const args: Expr[] = [];
        while (!this.atEnd() && !this.check('punct', ')')) {
          const arg = this.parseExpr();
          if (arg === null) return null;
          args.push(arg);
          if (this.accept('punct', ',') === null) break;
        }
        const close = this.expect('punct', ')', 'DS0110');
        if (close === null) return null;
        expr = {
          kind: 'call',
          callee: expr,
          args,
          span: { start: expr.span.start, end: close.end },
        };
        continue;
      }

      /*
       * `?` is postfix propagation here, and never a type's `?`.
       *
       * The two never collide: a type appears after `:` or `->` and is parsed by `parseTypeRef`,
       * which consumes its own `?` before control returns to an expression position.
       */
      if (this.check('punct', '?')) {
        const mark = this.next();
        expr = { kind: 'try', inner: expr, span: { start: expr.span.start, end: mark.end } };
        continue;
      }

      return expr;
    }
  }

  private parsePrimary(): Expr | null {
    const token = this.peek();

    /*
     * A query is not a value, and this is where that stops being a claim.
     *
     * The entity model says a query result may not outlive the loop it was made in, because the
     * cursor comes from a pool and is given back when the loop ends. A query that cannot be bound
     * to anything cannot outlive anything, so the failure that rule warns about is unspellable.
     */
    if (token.kind === 'keyword' && token.text === 'query') {
      this.report(
        'DS0135',
        'a query is not a value: write `for <name> in query<…>() { … }`. The cursor comes from a ' +
          'pool and is given back when the loop ends, so a query held past its loop would read ' +
          'whatever the next one wrote into it.',
        { start: token.start, end: token.end },
      );
      this.next();
      return null;
    }

    if (token.kind === 'number') {
      this.next();
      /* A unit suffix is its own token immediately after the number, and it belongs to the literal
         rather than standing beside it — otherwise `30m` would parse as two expressions. */
      const unit = this.check('unit') ? this.next() : null;
      return {
        kind: 'number',
        value: Number(token.text),
        unit: unit?.text,
        span: { start: token.start, end: unit?.end ?? token.end },
      };
    }

    if (token.kind === 'string') {
      this.next();
      return {
        kind: 'string',
        value: token.text.slice(1, -1),
        span: { start: token.start, end: token.end },
      };
    }

    if (token.kind === 'keyword' && (token.text === 'true' || token.text === 'false')) {
      this.next();
      return {
        kind: 'bool',
        value: token.text === 'true',
        span: { start: token.start, end: token.end },
      };
    }

    if (token.kind === 'keyword' && token.text === 'match') return this.parseMatch();

    /*
     * A primitive name is a legal expression head, so `u8.clamp(v)` parses.
     *
     * `u8` is a keyword because the grammar and the checker must agree about type names, and a
     * conversion hangs off the type it converts *to* — which reads correctly and puts the width
     * where a reader looks for it. The alternative spellings all invent a free function whose name
     * has to encode the width.
     */
    if (token.kind === 'keyword' && isPrimitive(token.text)) {
      this.next();
      return { kind: 'ident', name: token.text, span: { start: token.start, end: token.end } };
    }

    if (this.check('punct', '[')) {
      const open = this.next();
      const items: Expr[] = [];
      /* A trailing comma is accepted the way a call's argument list accepts one: the loop takes a
         comma and then re-tests for the closing bracket. */
      while (!this.atEnd() && !this.check('punct', ']')) {
        const item = this.parseExpr();
        if (item === null) return null;
        items.push(item);
        if (this.accept('punct', ',') === null) break;
      }
      const close = this.expect('punct', ']', 'DS0110');
      if (close === null) return null;
      return { kind: 'listLiteral', items, span: { start: open.start, end: close.end } };
    }

    if (this.check('punct', '(')) {
      this.next();
      /* Parentheses re-enter ordinary expression position, which is how a condition that genuinely
         needs a record literal writes one: `if (Door { open: true }).open { … }`. Without this the
         suppression would have no escape and the shape would be unwritable rather than awkward. */
      const previous = this.inConditionPosition;
      this.inConditionPosition = false;
      const inner = this.parseExpr();
      this.inConditionPosition = previous;
      if (inner === null) return null;
      if (this.expect('punct', ')', 'DS0110') === null) return null;
      return inner;
    }

    if (token.kind === 'ident' || (token.kind === 'keyword' && isSoftKeyword(token.text))) {
      this.next();
      /*
       * `Name { … }` is a record literal, told from `if cond { … }` by requiring the brace on the
       * same line.
       *
       * This is the classic ambiguity of a syntax with both record literals and brace-delimited
       * blocks: `if door { … }` could be a condition and its body, or a record literal used as a
       * condition. Requiring no newline resolves it at no cost — a record literal split before its
       * own opening brace is not a shape anybody writes, and a condition is routinely followed by
       * its block on the same line.
       */
      if (this.check('punct', '{') && !this.startsNewLine() && !this.inConditionPosition) {
        return this.parseRecordLiteral(token);
      }
      return { kind: 'ident', name: token.text, span: { start: token.start, end: token.end } };
    }

    this.report('DS0115', `expected an expression but found \`${token.text}\``, {
      start: token.start,
      end: token.end,
    });
    return null;
  }

  /**
   * Whether the parser is reading a condition, where `{` opens a block rather than a record.
   *
   * The newline rule alone is not enough: `if door { … }` puts the brace on the same line as an
   * identifier, which is exactly the record-literal shape. So a condition suppresses record
   * literals outright, and a condition that genuinely needs one parenthesises it — which is the
   * same resolution Rust reaches for the same reason.
   */
  private inConditionPosition = false;

  private parseCondition(): Expr | null {
    const previous = this.inConditionPosition;
    this.inConditionPosition = true;
    try {
      return this.parseExpr();
    } finally {
      this.inConditionPosition = previous;
    }
  }

  private parseRecordLiteral(name: Token): Expr | null {
    this.next();
    const fields: { name: string; value: Expr; span: Span }[] = [];
    while (!this.atEnd() && !this.check('punct', '}')) {
      const field = this.acceptIdentLike();
      if (field === null) {
        const found = this.peek();
        this.report('DS0106', 'expected a field name', { start: found.start, end: found.end });
        return null;
      }
      if (this.expect('punct', ':', 'DS0107') === null) return null;
      const value = this.parseExpr();
      if (value === null) return null;
      fields.push({ name: field.text, value, span: { start: field.start, end: value.span.end } });
      if (this.accept('punct', ',') === null) break;
    }
    const close = this.expect('punct', '}', 'DS0102');
    if (close === null) return null;
    return { kind: 'record', name: name.text, fields, span: { start: name.start, end: close.end } };
  }

  private parseMatch(): Expr | null {
    const start = this.next().start;
    const subject = this.parseCondition();
    if (subject === null) return null;
    if (this.expect('punct', '{', 'DS0101') === null) return null;

    const arms: MatchArm[] = [];
    while (!this.atEnd() && !this.check('punct', '}')) {
      const pattern = this.parsePattern();
      if (pattern === null) break;
      if (this.expect('punct', '=>', 'DS0122') === null) break;
      const body = this.parseExpr();
      if (body === null) break;
      arms.push({ pattern, body, span: { start: pattern.span.start, end: body.span.end } });
      this.accept('punct', ',');
    }

    const close = this.expect('punct', '}', 'DS0102');
    if (close === null) return null;
    return { kind: 'match', subject, arms, span: { start, end: close.end } };
  }

  private parsePattern(): Pattern | null {
    if (this.check('ident', '_')) {
      const token = this.next();
      return { kind: 'wildcard', span: { start: token.start, end: token.end } };
    }

    const name = this.acceptIdentLike();
    if (name === null) {
      const found = this.peek();
      this.report('DS0123', 'expected a pattern', { start: found.start, end: found.end });
      return null;
    }

    let binding: string | undefined;
    let end = name.end;
    if (this.accept('punct', '(') !== null) {
      const bound = this.acceptIdentLike();
      if (bound === null) {
        const found = this.peek();
        this.report('DS0124', 'expected a name to bind the payload to', {
          start: found.start,
          end: found.end,
        });
        return null;
      }
      binding = bound.text;
      const close = this.expect('punct', ')', 'DS0110');
      if (close === null) return null;
      end = close.end;
    }

    return { kind: 'variant', name: name.text, binding, span: { start: name.start, end } };
  }

  result(module: Module): ParseResult {
    return { module, diagnostics: this.diagnostics };
  }
}

export function parse(
  source: string,
  file: string,
  /** This target's fixed simulation step, as steps per second. See the constant above. */
  fixedStepsPerSecond: number = DEFAULT_FIXED_STEPS_PER_SECOND,
): ParseResult {
  const { tokens, diagnostics } = tokenize(source, file);
  const parser = new Parser(file, source, tokens, diagnostics, fixedStepsPerSecond);
  return parser.result(parser.parseModule());
}

/**
 * The text of a string literal, with its quotes and escapes resolved.
 *
 * `JSON.parse` rather than a hand-rolled unescape: the language's string literals are
 * JSON-shaped, and a second unescaper would be a second place for `\n` to be wrong.
 */
function literalText(raw: string): string {
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw.slice(1, -1);
  }
}
