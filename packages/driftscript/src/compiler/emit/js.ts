/**
 * Typed IR to JavaScript ES modules.
 *
 * The first backend, and deliberately not the semantic definition. Everything it needs is on the
 * IR: types are resolved, units are erased, and compound assignment has already been expanded, so
 * this file contains no type inference and no desugaring. That is the property that makes a second
 * backend an evaluation rather than a rewrite.
 *
 * **Browser-valid with no Node assumptions.** No `require`, no `process`, no `__dirname`, no
 * `Buffer`, no `node:` specifiers. A generated module is loaded by a bundler and then by a browser,
 * and a Node global reaching one is a runtime error in the one place a script author cannot debug.
 */
import type {
  IrData,
  IrEnum,
  IrExpr,
  IrFn,
  IrHandler,
  IrModule,
  IrState,
  IrStmt,
  IrTask,
  IrType,
} from '../ir/ir.ts';
import { INTEGER_RANGE } from '../check/types.ts';
import { schemaOf } from '../schema/schema.ts';
import { SYSTEM_VIEW } from '../check/checker.ts';
import { entityMetadata } from './entityMeta.ts';
import { MappingBuilder, type SourceMap } from './sourceMap.ts';
import {
  type TaskStmt,
  type Terminator,
  blocksOf,
  frameField,
  frameNames,
  ownerText,
  rewriteStmts,
} from './task.ts';

export interface EmitOptions {
  readonly filename: string;
  readonly source: string;
  /**
   * Which build this is.
   *
   * Read for exactly one thing: whether editor metadata rides in the module's `__drift`. Defaults
   * to development, because a caller that has not thought about it wants the metadata rather than
   * silently shipping without it — a missing inspector is visible, a missing *build flag* is not.
   */
  readonly mode?: 'development' | 'production';
}

export interface EmitResult {
  readonly code: string;
  readonly map: SourceMap;
}

/** Where an offset falls, for the source map. Zero-based, which is what the format wants. */
function originalPosition(source: string, offset: number): { line: number; column: number } {
  let line = 0;
  let lineStart = 0;
  const clamped = Math.max(0, Math.min(offset, source.length));
  for (let i = 0; i < clamped; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart };
}

/**
 * A JavaScript identifier for a DriftScript name.
 *
 * Soft keywords make this necessary: `in` and `data` are legal parameter names in `.drs` and not
 * uniformly safe in JavaScript. Prefixing only the ones that collide keeps generated code readable
 * — a source map points at the original either way, but a person reading the output should still
 * recognise their own names.
 */
const JS_RESERVED: ReadonlySet<string> = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await', 'arguments', 'eval',
]);

function jsName(name: string): string {
  return JS_RESERVED.has(name) ? `${name}$` : name;
}

function literal(value: number | string | boolean): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/**
 * Writes text while tracking where it landed, so a mapping can be recorded at any point.
 *
 * Line and column are maintained rather than recomputed, because recomputing means scanning the
 * output for newlines on every mapping and the emitter records one per IR node.
 */
class Writer {
  private readonly parts: string[] = [];
  private readonly mappings = new MappingBuilder();
  private readonly source: string;
  line = 0;
  column = 0;
  indent = 0;

  constructor(source: string) {
    this.source = source;
  }

  write(text: string): void {
    this.parts.push(text);
    const lines = text.split('\n');
    if (lines.length === 1) {
      this.column += text.length;
      return;
    }
    this.line += lines.length - 1;
    this.column = lines[lines.length - 1].length;
  }

  /** Write a line at the current indentation. */
  line_(text: string): void {
    this.write('  '.repeat(this.indent) + text + '\n');
  }

  /** Open the current indentation for a block, run `body`, and close it. */
  block(open: string, body: () => void, close = '}'): void {
    this.line_(open);
    this.indent += 1;
    body();
    this.indent -= 1;
    this.line_(close);
  }

  /** Tie the current output position to an offset in the original source. */
  mark(offset: number): void {
    const original = originalPosition(this.source, offset);
    this.mappings.add({
      generatedLine: this.line,
      generatedColumn: this.column,
      originalLine: original.line,
      originalColumn: original.column,
    });
  }

  finish(): { code: string; mappings: string } {
    return { code: this.parts.join(''), mappings: this.mappings.encode() };
  }
}

/**
 * The runtime shape of an option and a result, and why it is a plain object.
 *
 * `{ tag: 'some', value }` rather than a class, for the reason records are plain objects: a class
 * gives every instance a prototype the runtime would have to preserve across a hot reload. A tag
 * string rather than a number because a debugger shows it, and because a script that survives into
 * a saved state is readable by a person looking for what went wrong.
 *
 * The cost is an allocation per wrap, which is why `@hot` will report one. What would make it wrong
 * is an option in a per-frame path, which the hot-path analysis exists to catch.
 */
const NONE = "{ tag: 'none' }";

function emitExprText(expr: IrExpr): string {
  switch (expr.kind) {
    case 'const':
      return literal(expr.value);
    case 'componentField':
      /*
       * `$v0_0.value[$i0_0]` — a property load and an array index.
       *
       * **Through the view, never through a local holding its array.** A column grows by
       * reallocation, and `add` is immediate inside a system, so a walk that adds a component grows
       * the array it is walking; a hoisted local would then be storage nothing reads, with no error
       * and no wrong type. The index local is refreshed per iteration for the same reason.
       */
      return `$v${expr.depth}_${expr.view}.${expr.field}[$i${expr.depth}_${expr.view}]`;
    case 'local':
      return jsName(expr.name);
    case 'field':
      return `${emitExprText(expr.target)}.${expr.name}`;
    case 'optionalField':
      /* An option is `{ tag, value }`, so reaching through one is a tag test rather than JavaScript's
         own `?.` — which tests for null and would read a `none` object's absent `value` as
         `undefined`, silently turning "no value" into "a value that is undefined". */
      return `(($t) => $t.tag === 'some' ? { tag: 'some', value: $t.value.${expr.name} } : ${NONE})(${emitExprText(expr.target)})`;
    case 'unary':
      return `(${expr.op}${emitExprText(expr.operand)})`;
    case 'binary':
      return emitBinary(expr);
    case 'call': {
      /*
       * An integer conversion becomes a helper call, because the width has to reach the runtime.
       *
       * `u8.clamp(v)` is not a method on anything — `u8` is a type name, and the generated code
       * needs the bit width and the signedness the type carried. Recognised here by the dotted
       * callee rather than given its own IR node, since every other dotted callee is an enum
       * constructor and the two never collide: an enum name is not a primitive name.
       */
      const conversion = conversionCall(expr);
      if (conversion !== null) return conversion;

      /*
       * `callee` may be dotted for an enum constructor — `Shape.Circle` — or for a capability call
       * — `audio.play`. Both emit the same way, and the host supplies the namespace object.
       *
       * Only the last segment can collide with a JavaScript keyword, since the first is a type name
       * or an import namespace.
       */
      const call = `${expr.callee.split('.').map(jsName).join('.')}(${expr.args.map(emitExprText).join(', ')})`;
      /* A capability polymorphic in its float width computes in double and narrows here. See
         `IrExpr`'s `rounds`, and note that an ordinary `f32` capability is not wrapped: the host
         returned the width it declared and re-rounding it would cost a call per frame for nothing. */
      return expr.rounds ? `Math.fround(${call})` : call;
    }
    case 'record':
      return `{ ${expr.fields.map((f) => `${f.name}: ${emitExprText(f.value)}`).join(', ')} }`;
    case 'wrap':
      if (expr.tag === 'none') return NONE;
      return `{ tag: '${expr.tag}', value: ${emitExprText(expr.value as IrExpr)} }`;
    case 'try':
      /* `?` is an early return, which an expression cannot do — so it becomes an immediately-invoked
         helper that returns the unwrapped value or rethrows the wrapper through a sentinel. The
         statement emitter unwraps that sentinel at the function boundary; see `emitFn`. */
      return `$try(${emitExprText(expr.inner)})`;
    case 'match':
      return emitMatch(expr);
  }
}

/** The numeric conversions, or `null` when the callee is something else. */
function conversionCall(expr: Extract<IrExpr, { kind: 'call' }>): string | null {
  const [owner, method] = expr.callee.split('.');
  if (method === undefined) return null;

  /*
   * A float conversion needs no helper, because JavaScript has exactly one number type.
   *
   * `f32.nearest(v)` is `Math.fround`, which is the whole of single precision here. `f64.nearest(v)`
   * is the value itself and emits nothing at all — every `f64` a script can hold is already a
   * double, so the conversion is a *type* claim the checker made and the backend has no work to do.
   * Emitting an identity call for it would put a function on a frame path to return its argument.
   */
  if (method === 'nearest' && (owner === 'f32' || owner === 'f64')) {
    const value = emitExprText(expr.args[0]);
    return owner === 'f32' ? `Math.fround(${value})` : value;
  }

  const range = INTEGER_RANGE[owner];
  if (range === undefined) return null;

  const value = emitExprText(expr.args[0]);
  const bounds = `${range.bits}, ${range.signed}`;
  if (method === 'clamp') return `$sat(${value}, ${bounds})`;
  if (method === 'wrap') return `$wrap(${value}, ${bounds})`;
  if (method === 'checked') return `$fit(${value}, ${bounds})`;
  return null;
}

function emitBinary(expr: Extract<IrExpr, { kind: 'binary' }>): string {
  const left = emitExprText(expr.left);
  const right = emitExprText(expr.right);

  const range = expr.type.kind === 'int' ? INTEGER_RANGE[expr.type.name] : undefined;

  /*
   * Integer arithmetic emits its chosen overflow behaviour, and there is no fourth option.
   *
   * A plain `+` on an integer is *checked*: it throws on overflow rather than producing a number
   * outside the type. That is the design's rule that there is no undefined integer behaviour, and
   * it is the one place generated code is deliberately slower than the JavaScript a person would
   * have written. `+%` and `+|` are the opt-outs, and `@hot` is where the cost gets measured.
   */
  if (range !== undefined) {
    const base = expr.op[0];
    if (expr.op.endsWith('%')) return `$wrap(${left} ${base} ${right}, ${range.bits}, ${range.signed})`;
    if (expr.op.endsWith('|')) return `$sat(${left} ${base} ${right}, ${range.bits}, ${range.signed})`;
    if (['+', '-', '*', '/', '%'].includes(expr.op)) {
      return `$chk(${left} ${expr.op} ${right}, ${range.bits}, ${range.signed})`;
    }
  }

  /*
   * `f32` arithmetic rounds through `Math.fround` at the operation, not at every read.
   *
   * A chain of three adds gets one `fround` per operation, which is what single precision actually
   * means — rounding only at the end would compute in double and report a different answer than the
   * same expression in a shader.
   */
  if (expr.type.kind === 'f32' && ['+', '-', '*', '/'].includes(expr.op)) {
    return `Math.fround(${left} ${expr.op} ${right})`;
  }

  return `(${left} ${expr.op} ${right})`;
}

function emitMatch(expr: Extract<IrExpr, { kind: 'match' }>): string {
  /*
   * A `match` is an expression, so it becomes an arrow applied to the subject.
   *
   * The subject is bound once — a `match` over a call must not call twice — and the arms become a
   * chain of ternaries. A `switch` would need a statement position this does not have.
   */
  const arms = expr.arms.map((arm) => {
    if (arm.variant === null) return { test: null, arm };
    return { test: `$s.tag === '${arm.variant}'`, arm };
  });

  let out = 'undefined';
  for (let i = arms.length - 1; i >= 0; i -= 1) {
    const { test, arm } = arms[i];
    /* The arrow's parameter is the binding's own name, so the body's references resolve to it. An
       earlier version prefixed the parameter and left the body unprefixed, which generated an arrow
       whose parameter nothing used and whose body reached an undefined outer name — valid
       JavaScript that computes `NaN`. */
    const body =
      arm.binding === null
        ? emitExprText(arm.body)
        : `((${jsName(arm.binding)}) => ${emitExprText(arm.body)})($s.value)`;
    out = test === null ? body : `${test} ? ${body} : ${out}`;
  }

  return `(($s) => ${out})(${emitExprText(expr.subject)})`;
}

function emitStmt(writer: Writer, stmt: IrStmt): void {
  writer.mark(stmt.span.start);
  switch (stmt.kind) {
    case 'let':
      writer.line_(`let ${jsName(stmt.name)} = ${emitExprText(stmt.value)};`);
      return;
    case 'assign':
      writer.line_(`${emitExprText(stmt.target)} = ${emitExprText(stmt.value)};`);
      return;
    case 'return':
      writer.line_(stmt.value === null ? 'return;' : `return ${emitExprText(stmt.value)};`);
      return;
    case 'expr':
      writer.line_(`${emitExprText(stmt.expr)};`);
      return;
    case 'awaitTask':
      /* Unreachable for the same reason a clock await is: the cut puts a suspend in a terminator. */
      throw new Error('an await reached the statement emitter, which means the body was not cut');
    case 'become':
      /* An entry block is a task and carries the machine on its frame; an `on` handler is a plain
         function and takes it as a parameter. Two shapes because they are two kinds of code. */
      writer.line_(
        `${stmt.inEntry ? MACHINE_FIELD : '$m'}.become(${JSON.stringify(stmt.state)});`,
      );
      return;
    case 'emit': {
      const fields = stmt.fields.map((f) => `${f.name}: ${emitExprText(f.value)}`).join(', ');
      writer.line_(`$rt.emit(${JSON.stringify(stmt.event)}, { ${fields} });`);
      return;
    }
    case 'spawn': {
      const args = stmt.args.map(emitExprText);
      writer.line_(
        `$rt.spawn(${jsName(stmt.task)}, ${ownerText(stmt.owner)}` +
          `${args.map((a) => `, ${a}`).join('')});`,
      );
      return;
    }
    case 'scope': {
      /* A scope with no suspend inside it stays one statement, so its open and close are a `try`
         and a `finally` rather than two blocks — which is what makes a `return` out of the middle
         still leave it. A scope that *does* suspend cannot use that shape, because a suspend is a
         `return` and would run the `finally` on the way out. */
      writer.line_(`$f.${frameField(stmt.name)} = $rt.createScope(${ownerText(stmt.parent)});`);
      writer.block('try {', () => {
        for (const inner of stmt.body) emitStmt(writer, inner);
      });
      writer.block('finally {', () => {
        writer.line_(`$f.${frameField(stmt.name)}.leave();`);
      });
      return;
    }
    case 'await':
      /* Unreachable: a block's statements never contain a suspend, because the cut is what puts
         one in a terminator. Emitting nothing here would be a task that silently never waits. */
      throw new Error('an await reached the statement emitter, which means the body was not cut');
    case 'if':
      writer.block(`if (${emitExprText(stmt.condition)}) {`, () => {
        for (const inner of stmt.then) emitStmt(writer, inner);
      });
      if (stmt.otherwise !== null) {
        writer.block('else {', () => {
          for (const inner of stmt.otherwise as readonly IrStmt[]) emitStmt(writer, inner);
        });
      }
      return;
    case 'ifLet': {
      const subject = emitExprText(stmt.subject);
      writer.line_(`const $o_${jsName(stmt.name)} = ${subject};`);
      writer.block(`if ($o_${jsName(stmt.name)}.tag === 'some') {`, () => {
        writer.line_(`const ${jsName(stmt.name)} = $o_${jsName(stmt.name)}.value;`);
        for (const inner of stmt.then) emitStmt(writer, inner);
      });
      if (stmt.otherwise !== null) {
        writer.block('else {', () => {
          for (const inner of stmt.otherwise as readonly IrStmt[]) emitStmt(writer, inner);
        });
      }
      return;
    }
    case 'while':
      writer.block(`while (${emitExprText(stmt.condition)}) {`, () => {
        for (const inner of stmt.body) emitStmt(writer, inner);
      });
      return;
    case 'forQuery':
      emitQuery(writer, stmt);
      return;
  }
}

/**
 * The index into a component's columns, from an entity handle.
 *
 * `2 ** 26`, written as the literal it evaluates to. Generated code imports nothing, so the entity
 * model's `entityIndex` cannot arrive as a function — and a handle carries a 26-bit index with the
 * generation above it, so the index is the remainder. **What this costs** is a magic number in
 * output a person may read; the comment the emitter writes beside it is what pays for that.
 * **What would make it wrong** is the entity model changing its 26/27 split, which is why that
 * split lives in one place there and this line names it.
 */
const ENTITY_INDEX_MODULUS = 2 ** 26;

/**
 * `for e in query<…>() { … }`.
 *
 * ```js
 * const $q0 = ecs.query($view, "Hunger");
 * const $v0 = ecs.view($view, "Hunger", true);
 * for (;;) {
 *   const e = ecs.next($q0);
 *   if (e < 0) break;
 *   const $i0 = $v0.sparse[e % 67108864];
 *   $v0.value[$i0] = 1;
 * }
 * ```
 *
 * **The view is held and its arrays are not.** `$v0.value[$i0]` is a property load and an index
 * rather than a host call, which is the whole point — but hoisting `$v0.value` into a local would
 * undo the thing the view exists for: a column grows by reallocation, `add` is immediate inside a
 * system, and a walk that adds a component grows the array it is walking. A local would then be
 * storage nothing reads, with no error and no wrong type.
 *
 * **A negative ends the walk** rather than a result record, so nothing is allocated per step to say
 * "done" — and zero is a legal handle, which is why the sentinel is below zero rather than at it.
 *
 * **Temporaries are numbered by the loop's own depth, which the IR carries.** This kept a counter
 * of its own until a perturbation showed the two could disagree: a `componentField` names the depth
 * the lowering assigned, so a second count here made a nested loop's field access point at the
 * outer loop's view while every declaration still looked right.
 *
 * **And the whole thing is wrapped in a block, because depth is not identity.** Two loops one
 * after the other are both at depth 0, so both declare `$q0` — and in one scope that is
 * `SyntaxError: Identifier '$q0' has already been declared`, thrown when the generated module
 * loads, naming a source nobody wrote. A block per loop makes siblings disjoint while leaving
 * nesting exactly as it was, since an inner block still sees the outer's names. The alternative —
 * a counter beside the depth — is the thing the paragraph above records already going wrong once.
 */
function emitQuery(writer: Writer, stmt: Extract<IrStmt, { kind: 'forQuery' }>): void {
  writer.block('{', () => emitQueryScoped(writer, stmt));
}

function emitQueryScoped(writer: Writer, stmt: Extract<IrStmt, { kind: 'forQuery' }>): void {
  const depth = stmt.depth;

  const cursor = `$q${depth}`;
  const world = jsName(stmt.world);
  const terms = stmt.required.map((name) => JSON.stringify(name)).join(', ');
  writer.line_(`const ${cursor} = ecs.query(${world}, ${terms});`);
  for (const excluded of stmt.excluded) {
    writer.line_(`ecs.without(${cursor}, ${JSON.stringify(excluded)});`);
  }

  const views = stmt.views.map((view, index) => ({ ...view, local: `$v${depth}_${index}` }));
  for (const view of views) {
    writer.line_(
      `const ${view.local} = ecs.view(${world}, ${JSON.stringify(view.component)}, ${view.forWriting});`,
    );
  }

  writer.block('for (;;) {', () => {
    writer.line_(`const ${jsName(stmt.binding)} = ecs.next(${cursor});`);
    writer.line_(`if (${jsName(stmt.binding)} < 0) break;`);
    for (const view of views) {
      /* The index into this component's columns for the entity in hand. Read through the view every
         iteration, because the view's `sparse` is replaced when the store grows. */
      writer.line_(
        `const $i${depth}_${views.indexOf(view)} = ${view.local}.sparse[` +
          `${jsName(stmt.binding)} % ${ENTITY_INDEX_MODULUS}];`,
      );
    }
    for (const inner of stmt.body) emitStmt(writer, inner);
  });
}

/**
 * A factory per record, rather than a class.
 *
 * A class would give every instance a prototype and an identity the runtime would then have to
 * preserve across a hot reload — and preserving a prototype across a module replacement is exactly
 * the thing that makes hot reload fragile elsewhere. A plain object has no identity beyond its
 * fields, so a patched module's functions operate on instances the old module created without
 * anything having to be migrated.
 *
 * The cost is no methods on a record. What would make it wrong is a language that grows them, which
 * this one does not: behaviour is a `fn` taking the record, which is also what makes a system's
 * declared reads and writes checkable.
 */
function emitData(writer: Writer, data: IrData): void {
  writer.mark(data.span.start);
  writer.block(`export function create${data.name}() {`, () => {
    if (data.fields.length === 0) {
      writer.line_('return {};');
      return;
    }
    /* One field per line so each can carry its own mapping. A single-line object literal reads
       more compactly and maps every field to the same generated position, which turns a stack
       trace inside an initialiser into a pointer at the record rather than at the field. */
    writer.block('return {', () => {
      for (const field of data.fields) {
        writer.mark(field.init.span.start);
        writer.line_(`${field.name}: ${emitExprText(field.init)},`);
      }
    }, '};');
  });
  writer.write('\n');
}

/**
 * An enum becomes a frozen object of tag strings, and a payload variant becomes a constructor.
 *
 * Strings rather than integers because a debugger and a saved state both show them, and because a
 * stable-across-versions representation is what a schema migration will need. Frozen because a
 * consumer reassigning a variant would break every `match` at once, silently.
 */
function emitEnum(writer: Writer, decl: IrEnum): void {
  writer.mark(decl.span.start);
  writer.block(`export const ${decl.name} = Object.freeze({`, () => {
    for (const variant of decl.variants) {
      writer.line_(
        variant.hasPayload
          ? `${variant.name}: (value) => ({ tag: '${variant.name}', value }),`
          : `${variant.name}: { tag: '${variant.name}' },`,
      );
    }
  }, '});');
  writer.write('\n');
}

/**
 * A task: a frame constructor and a switch over its resume points.
 *
 * Every binding is initialised in `start`, including the ones that have no value yet, so every
 * frame of a given task has the same shape from its first tick. A field added later would make the
 * engine reshape the object mid-run, which is the one allocation a scheduler that allocates nothing
 * could still be paying for.
 *
 * `continue` inside the `switch` targets the `for`, so an ordinary jump costs a dispatch and no
 * call. A suspend is the only `return` that is not the end.
 */
/**
 * Where an entry task keeps the machine it belongs to.
 *
 * Two `$` so it cannot collide with a binding a script declared: `frameField` prefixes exactly one,
 * so a task local called `$machine` becomes `$f.$$machine`... which would collide. It is called
 * `machine` here instead, and the doubled prefix makes the two spaces disjoint.
 */
const MACHINE_FIELD = '$f.$$machine';

interface TaskEmitOptions {
  /** What opens the object. A state's entry block is a property rather than an export. */
  readonly open?: string;
  readonly close?: string;
  /** Whether `start` takes the machine this body belongs to, which only a state's entry does. */
  readonly machine?: boolean;
}

function emitTask(writer: Writer, task: IrTask, options: TaskEmitOptions = {}): void {
  writer.mark(task.span.start);

  const bound = new Set(frameNames(task));
  const blocks = blocksOf(rewriteStmts(task.body, bound));
  const params = task.params.map((p) => jsName(p.name));
  const machine = options.machine === true;

  writer.block(options.open ?? `export const ${jsName(task.name)} = {`, () => {
    writer.line_(`name: ${JSON.stringify(task.name)},`);

    writer.block(
      `start($f${params.map((p) => `, ${p}`).join('')}${machine ? ', $machine' : ''}) {`,
      () => {
      writer.line_('$f.step = 0;');
      if (machine) writer.line_(`${MACHINE_FIELD} = $machine;`);
      for (const param of task.params) {
        writer.line_(`$f.${frameField(param.name)} = ${jsName(param.name)};`);
      }
      for (const name of bound) {
        if (task.params.some((p) => p.name === name)) continue;
        writer.line_(`$f.${frameField(name)} = undefined;`);
      }
    }, '},');

    writer.block('resume($f) {', () => {
      writer.block('for (;;) {', () => {
        writer.block('switch ($f.step) {', () => {
          blocks.forEach((block, index) => {
            writer.block(`case ${index}: {`, () => {
              for (const stmt of block.stmts) emitTaskStmt(writer, stmt);
              emitTerminator(writer, block.terminator);
            });
          });
          /* Reached by a jump to a block the emitter dropped as unreachable, and by a frame whose
             step a hot patch left pointing past the end of a shorter version. Finishing is the
             honest answer to both: the task has no code at that point. */
          writer.line_("default: return 'done';");
        });
      });
    }, '},');
  }, options.close ?? '};');

  if (options.open === undefined) writer.write('\n');
}

/**
 * The module's machine: a table of states and a factory.
 *
 * A **factory** rather than a single machine, because a script describing a door describes every
 * door: a consumer makes one per thing. The states table is shared and holds no state of its own,
 * so the cost of a second machine is the object the runtime allocates and nothing here.
 */
function emitStates(writer: Writer, states: readonly IrState[]): void {
  const [initial] = states;
  if (initial === undefined) return;

  writer.block('const $states = {', () => {
    for (const state of states) {
      writer.mark(state.span.start);
      writer.block(`${jsName(state.name)}: {`, () => {
        if (state.enter === null) writer.line_('enter: null,');
        else emitTask(writer, state.enter, { open: 'enter: {', close: '},', machine: true });

        writer.block('on: {', () => {
          for (const handler of state.handlers) {
            /* The payload parameter exists only where the state named it. An unused one would be
               a parameter nothing in the language can ever reach. */
            const payload = handler.binding === null ? '' : `, ${jsName(handler.binding)}`;
            writer.block(`${jsName(handler.event)}($m${payload}) {`, () => {
              for (const stmt of handler.body) emitStmt(writer, stmt);
            }, '},');
          }
        }, '},');
      }, '},');
    }
  }, '};');
  writer.write('\n');

  writer.block('export function createMachine() {', () => {
    writer.line_(`return $rt.createMachine(${JSON.stringify(initial.name)}, $states, $rt.scope);`);
  });
  writer.write('\n');
}

/** Whether any function or task body emits, which is what decides a module needs the runtime. */
function usesEmit(ir: IrModule): boolean {
  const walk = (stmts: readonly IrStmt[]): boolean =>
    stmts.some((stmt) => {
      switch (stmt.kind) {
        case 'emit':
          return true;
        case 'if':
        case 'ifLet':
          return walk(stmt.then) || (stmt.otherwise !== null && walk(stmt.otherwise));
        case 'while':
        case 'scope':
          return walk(stmt.body);
        default:
          return false;
      }
    });
  return ir.fns.some((fn) => walk(fn.body)) || ir.tasks.some((task) => walk(task.body));
}

/** A module-level `on` handler: a named function, registered by `__runtime`. */
function emitHandler(writer: Writer, handler: IrHandler): void {
  writer.mark(handler.span.start);
  writer.block(`function ${handler.name}(${jsName(handler.binding)}) {`, () => {
    for (const stmt of handler.body) emitStmt(writer, stmt);
  });
  writer.write('\n');
}

/** A block's statement: the two the cut introduces, then everything the ordinary emitter handles. */
function emitTaskStmt(writer: Writer, stmt: TaskStmt): void {
  if (stmt.kind === 'scopeOpen') {
    writer.mark(stmt.span.start);
    writer.line_(`$f.${frameField(stmt.name)} = $rt.createScope(${ownerText(stmt.parent)});`);
    return;
  }
  if (stmt.kind === 'scopeClose') {
    writer.mark(stmt.span.start);
    writer.line_(`$f.${frameField(stmt.name)}.leave();`);
    return;
  }
  emitStmt(writer, stmt);
}

function emitTerminator(writer: Writer, terminator: Terminator): void {
  switch (terminator.kind) {
    case 'done':
      writer.line_("return 'done';");
      return;
    case 'jump':
      writer.line_(`$f.step = ${terminator.target};`);
      writer.line_('continue;');
      return;
    case 'branch':
      writer.block(`if (${emitExprText(terminator.condition)}) {`, () => {
        writer.line_(`$f.step = ${terminator.then};`);
        writer.line_('continue;');
      });
      writer.line_(`$f.step = ${terminator.otherwise};`);
      writer.line_('continue;');
      return;
    case 'awaitTask': {
      /*
       * The awaited task is spawned into the same owner a `spawn` here would use, so leaving that
       * scope cancels it — and the waiter then resumes, because a cancelled task is `done`. A
       * waiter suspended forever on work that will never finish is the alternative.
       */
      const args = terminator.args.map(emitExprText);
      writer.line_(
        `$f.awaiting = $rt.spawn(${jsName(terminator.task)}, ${ownerText(terminator.owner)}` +
          `${args.map((a) => `, ${a}`).join('')});`,
      );
      writer.line_(`$f.step = ${terminator.next};`);
      writer.line_("return 'waiting';");
      return;
    }
    case 'await':
      writer.line_('$f.awaiting = null;');
      writer.line_(`$f.clock = ${JSON.stringify(terminator.clock)};`);
      writer.line_(
        `$f.deadline = $rt.deadlineAfter(${JSON.stringify(terminator.clock)}, ` +
          `${emitExprText(terminator.duration)});`,
      );
      writer.line_(`$f.step = ${terminator.next};`);
      writer.line_("return 'waiting';");
      return;
  }
}

function emitFn(writer: Writer, fn: IrFn): void {
  writer.mark(fn.span.start);
  const params = fn.params.map((p) => jsName(p.name)).join(', ');
  writer.block(`export function ${jsName(fn.name)}(${params}) {`, () => {
    /*
     * `?` needs an early return from inside an expression, which JavaScript cannot express.
     *
     * A function containing one gets a `try`/`catch` around its body and `$try` throws a sentinel
     * carrying the failure. The wrapper is emitted only where it is needed, so a function with no
     * `?` pays nothing — which matters because the alternative reading is that every generated
     * function has a `try` block in it.
     */
    if (usesTry(fn.body)) {
      writer.block('try {', () => {
        for (const stmt of fn.body) emitStmt(writer, stmt);
      });
      writer.block('catch ($e) {', () => {
        writer.line_('if ($e && $e.$drift) return $e.value;');
        writer.line_('throw $e;');
      });
    } else {
      for (const stmt of fn.body) emitStmt(writer, stmt);
    }
  });
  writer.write('\n');
}

function usesTry(stmts: readonly IrStmt[]): boolean {
  const inExpr = (expr: IrExpr): boolean => {
    switch (expr.kind) {
      case 'try':
        return true;
      case 'field':
      case 'optionalField':
        return inExpr(expr.target);
      case 'unary':
        return inExpr(expr.operand);
      case 'binary':
        return inExpr(expr.left) || inExpr(expr.right);
      case 'call':
        return expr.args.some(inExpr);
      case 'record':
        return expr.fields.some((f) => inExpr(f.value));
      case 'wrap':
        return expr.value !== null && inExpr(expr.value);
      case 'match':
        return inExpr(expr.subject) || expr.arms.some((a) => inExpr(a.body));
      default:
        return false;
    }
  };

  return stmts.some((stmt) => {
    switch (stmt.kind) {
      case 'let':
        return inExpr(stmt.value);
      case 'assign':
        return inExpr(stmt.target) || inExpr(stmt.value);
      case 'return':
        return stmt.value !== null && inExpr(stmt.value);
      case 'expr':
        return inExpr(stmt.expr);
      case 'if':
        return (
          inExpr(stmt.condition) ||
          usesTry(stmt.then) ||
          (stmt.otherwise !== null && usesTry(stmt.otherwise))
        );
      case 'ifLet':
        return (
          inExpr(stmt.subject) ||
          usesTry(stmt.then) ||
          (stmt.otherwise !== null && usesTry(stmt.otherwise))
        );
      case 'while':
        return inExpr(stmt.condition) || usesTry(stmt.body);
    }
  });
}

/**
 * The arithmetic and propagation helpers, emitted only into modules that use them.
 *
 * Inlined per module rather than imported from the runtime, because a generated module that
 * imported the runtime would be a generated module a consumer cannot tree-shake — and because the
 * whole point of the `exports` split is that generated code depends on nothing.
 */
const HELPERS: Readonly<Record<string, string>> = {
  $chk: `function $chk(v, bits, signed) {
  const lo = signed ? -(2 ** (bits - 1)) : 0;
  const hi = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  const t = Math.trunc(v);
  if (t < lo || t > hi) throw new RangeError('integer overflow: ' + v);
  return t;
}`,
  $wrap: `function $wrap(v, bits, signed) {
  const span = 2 ** bits;
  let t = Math.trunc(v) % span;
  if (t < 0) t += span;
  return signed && t >= span / 2 ? t - span : t;
}`,
  $sat: `function $sat(v, bits, signed) {
  const lo = signed ? -(2 ** (bits - 1)) : 0;
  const hi = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  return Math.min(hi, Math.max(lo, Math.trunc(v)));
}`,
  $fit: `function $fit(v, bits, signed) {
  const lo = signed ? -(2 ** (bits - 1)) : 0;
  const hi = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  const t = Math.trunc(v);
  return t < lo || t > hi ? { tag: 'none' } : { tag: 'some', value: t };
}`,
  $try: `function $try(v) {
  if (v.tag === 'Ok' || v.tag === 'some') return v.value;
  throw { $drift: true, value: v };
}`,
};

export function emitJs(ir: IrModule, options: EmitOptions): EmitResult {
  const writer = new Writer(options.source);

  /*
   * File imports come first, above everything.
   *
   * A generated module reads an imported binding inside a function body, never at load, so the
   * position is not a correctness requirement here the way it would be in a language with top-level
   * statements. It is a legibility one: a person opening generated output should see what it depends
   * on before what it does, exactly as they would in source they wrote.
   *
   * The specifier gains `.drs` because a bundler resolving generated JavaScript needs an extension,
   * while the `.drs` source deliberately carries none — `drift/audio` carries none either, and a
   * language that spells two kinds of import two ways is a language with a rule to remember.
   */
  for (const imported of ir.imports) {
    if (imported.values.length === 0) continue;
    writer.line_(
      `import { ${imported.values.map(jsName).join(', ')} } from '${imported.module}.drs';`,
    );
  }
  if (ir.imports.some((i) => i.values.length > 0)) writer.write('\n');

  /*
   * Host namespaces are module-level bindings the host fills in, not imports.
   *
   * `audio.play(…)` compiles to a call on a `let audio` that starts undefined and is assigned by
   * `__bind`. An `import` would be the obvious alternative and is wrong twice over: the specifier
   * would have to be a real module path, which ties generated code to a host's package layout; and
   * it would make a generated module import something, which is what stops a consumer tree-shaking
   * it.
   *
   * Starting `undefined` is deliberate rather than defensive. A module used before it is bound
   * fails at the first capability call with the namespace's own name in the error, which is a
   * clearer failure than a silent no-op object would give.
   */
  if (ir.namespaces.length > 0) {
    for (const namespace of ir.namespaces) writer.line_(`let ${jsName(namespace.alias)};`);
    writer.write('\n');
    writer.block('export function __bind($host) {', () => {
      for (const namespace of ir.namespaces) {
        writer.line_(`${jsName(namespace.alias)} = $host[${JSON.stringify(namespace.module)}];`);
      }
    });
    writer.write('\n');
  }

  /*
   * The runtime handle, bound the way host namespaces are and for the same reason: a generated
   * module imports nothing, so the scheduler cannot arrive as an import. It is `__runtime` rather
   * than another entry in `$host` because the scheduler belongs to the language rather than to a
   * host — putting it in the implementation map would make it look like a capability a target could
   * decline, and a target declining the language's own scheduler is not a thing that should parse.
   */
  const needsRuntime =
    ir.tasks.length > 0 || ir.handlers.length > 0 || ir.states.length > 0 || usesEmit(ir);
  if (needsRuntime) {
    writer.line_('let $rt;');
    writer.write('\n');
    writer.block('export function __runtime($r) {', () => {
      writer.line_('$rt = $r;');
      /*
       * Handlers are registered here, at load, and named rather than inline — a named function is
       * one object made once, where an arrow per handler would be one closure made every time a
       * module is loaded or reloaded. They belong to the module's scope, so disposing it closes
       * them without the module knowing they existed.
       */
      for (const handler of ir.handlers) {
        writer.line_(
          `$rt.on(${JSON.stringify(handler.event)}, ${handler.name}, $rt.scope);`,
        );
      }
    });
    writer.write('\n');
  }

  for (const decl of ir.enums) emitEnum(writer, decl);
  for (const data of ir.data) emitData(writer, data);
  for (const fn of ir.fns) emitFn(writer, fn);
  for (const task of ir.tasks) emitTask(writer, task);
  for (const handler of ir.handlers) emitHandler(writer, handler);
  emitStates(writer, ir.states);
  /*
   * Every system becomes an exported function taking the view the schedule hands it, named by the
   * checker's `SYSTEM_VIEW` rather than by a second spelling of it.
   *
   * **Before `writer.finish()`, which is not obvious and cost a debugging round.** This loop sat
   * after it, so every system body was written into a writer that had already produced its output
   * — no error, no warning, and a module with a system in it simply did not contain one.
   */
  for (const system of ir.systems) {
    writer.block(`export function ${jsName(system.name)}(${SYSTEM_VIEW}) {`, () => {
      for (const stmt of system.body) emitStmt(writer, stmt);
    });
    writer.write('\n');
  }

  const { code: body, mappings } = writer.finish();

  /* Helpers are prepended only when the generated body mentions them, which keeps a module that
     does plain float arithmetic free of integer machinery. Detected by name in the output rather
     than by walking the IR again: the emitter is the only thing that writes these names. */
  const used = Object.keys(HELPERS).filter((name) => body.includes(`${name}(`));
  const preamble = used.length === 0 ? '' : `${used.map((n) => HELPERS[n]).join('\n\n')}\n\n`;

  const shapes = Object.fromEntries(ir.data.map((d) => [d.name, d.fields.map((f) => f.name)]));
  /*
   * The schemas ride along with the shapes rather than replacing them.
   *
   * `shapes` answers "did the layout change" in one array comparison, which is what a patch needs
   * before it decides to do anything at all. `schemas` answers "which field is which", which is
   * what a migration needs *after* that decision. Both are cheap and they are asked at different
   * moments; collapsing them would make the cheap question pay for the expensive one.
   */
  const schemas = Object.fromEntries(ir.data.map((d) => [d.name, schemaOf(d)]));
  const entities = entityMetadata(ir, options.mode ?? 'development');
  const metadata = `export const __drift = ${JSON.stringify(
    {
      module: options.filename,
      requires: ir.requires,
      shapes,
      schemas,
      /* A host reads these to build a world: a store per component, a prefab per prefab, and a
         system definition per system. Always present, so a host reads a field rather than tests
         for one. */
      components: entities.components,
      entityTypes: entities.entities,
      systems: entities.systems,
      prefabs: entities.prefabs,
      /* Whether the host must call `__bind` before anything else in this module works. A runtime
         that guessed by looking for the export would be guessing; this says so. */
      binds: ir.namespaces.length > 0,
    },
    null,
    0,
  )};\n`;

  /*
   * The preamble shifts every generated line, so the mappings shift with it.
   *
   * Prepending text after the mappings were built is exactly the off-by-N that makes a source map
   * point at plausible but wrong lines. The shift is applied to the encoded string by prefixing one
   * empty group per preamble line, which is what the format's `;` separator means.
   */
  const preambleLines = preamble === '' ? 0 : preamble.split('\n').length - 1;
  const shifted = preambleLines === 0 ? mappings : ';'.repeat(preambleLines) + mappings;

  return {
    code: preamble + body + metadata,
    map: {
      version: 3,
      file: `${options.filename}.js`,
      sources: [options.filename],
      sourcesContent: [options.source],
      names: [],
      mappings: shifted,
    },
  };
}
