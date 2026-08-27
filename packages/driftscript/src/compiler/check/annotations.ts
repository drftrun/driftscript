/**
 * `@aiTool` and `@aiContext`, and the schemas they generate.
 *
 * A tool schema is derived from the signature the checker already validated, so it
 * cannot drift from the implementation. That is the whole payoff of the registry: this
 * is different from writing a prompt that describes some functions, because nobody
 * writes the description twice.
 *
 * **Nothing here checks the determinism boundary**, and no new code exists for it.
 * `DS0261` already refuses a `@deterministic` function that reaches the `ai` effect,
 * naming the capability it reached. The parent design wrote `DS3104` for this case,
 * from a block that does not exist — and a second code for an identical failure would
 * split a consumer's grep in half.
 */
import type { Diagnostic, DiagnosticCode } from '../diagnostics.ts';
import type { FnDecl, Span, TypeRef } from '../ast.ts';

/** What a model may be asked to produce. Anything else cannot be validated or traced. */
export type ToolSchema =
  | { readonly kind: 'string' }
  | { readonly kind: 'number' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'array'; readonly of: ToolSchema }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, ToolSchema>> };

export interface GeneratedTool {
  readonly name: string;
  readonly description: string;
  readonly schema: ToolSchema;
}

export interface GeneratedContext {
  readonly name: string;
  readonly description: string;
}

export interface AnnotationResult {
  readonly tools: readonly GeneratedTool[];
  readonly contexts: readonly GeneratedContext[];
  readonly diagnostics: readonly Diagnostic[];
}

/*
 * The scalar types a schema can carry, and nothing more.
 *
 * Integers and floats both become `number` because that is what a schema can say. The
 * language keeps the distinction and re-checks it at the call; the schema is what the
 * *model* is told, and telling it `u8` would be telling it something no provider
 * enforces.
 */
const SCALARS: Readonly<Record<string, ToolSchema>> = {
  i8: { kind: 'number' },
  i16: { kind: 'number' },
  i32: { kind: 'number' },
  i64: { kind: 'number' },
  u8: { kind: 'number' },
  u16: { kind: 'number' },
  u32: { kind: 'number' },
  u64: { kind: 'number' },
  f32: { kind: 'number' },
  f64: { kind: 'number' },
  String: { kind: 'string' },
  bool: { kind: 'boolean' },
};

export function checkAiAnnotations(
  functions: readonly FnDecl[],
  file: string,
): AnnotationResult {
  const tools: GeneratedTool[] = [];
  const contexts: GeneratedContext[] = [];
  const diagnostics: Diagnostic[] = [];

  const report = (code: DiagnosticCode, message: string, span: Span): void => {
    diagnostics.push({ code, message, file, severity: 'error', start: span.start, end: span.end });
  };

  for (const fn of functions) {
    const isTool = fn.annotations.includes('aiTool');
    const isContext = fn.annotations.includes('aiContext');
    if (!isTool && !isContext) continue;

    const key = isTool ? 'aiTool.description' : 'aiContext.description';
    const description = (fn.annotationArgs?.get(key) ?? '').trim();
    if (description === '') {
      /*
       * A description is part of the operating manual rather than a nicety: it is the
       * only thing telling the model *when* to reach for this, and a tool with none is
       * a tool the model calls at random or never.
       */
      report(
        'DS0286',
        `\`${fn.name}\` is annotated \`@${isTool ? 'aiTool' : 'aiContext'}\` but carries no ` +
          'description, which is what tells a model when to use it',
        fn.span,
      );
      continue;
    }

    if (isContext) {
      contexts.push({ name: fn.name, description });
      continue;
    }

    const fields: Record<string, ToolSchema> = {};
    let expressible = true;
    for (const param of fn.params) {
      const schema = schemaOf(param.type);
      if (schema === null) {
        report(
          'DS0287',
          `\`${fn.name}\` is annotated \`@aiTool\` but its parameter \`${param.name}\` has type ` +
            `\`${describeType(param.type)}\`, which no schema can express — a model cannot be asked for it, ` +
            'and a recorded trace could not carry it',
          fn.span,
        );
        expressible = false;
        continue;
      }
      fields[param.name] = schema;
    }

    if (expressible) {
      tools.push({ name: fn.name, description, schema: { kind: 'object', fields } });
    }
  }

  return { tools, contexts, diagnostics };
}

/** A schema for a declared type, or `null` when none exists. */
function schemaOf(type: TypeRef): ToolSchema | null {
  if (type.kind === 'primitive' || type.kind === 'named') {
    if (type.name === 'Array' && type.args.length === 1) {
      const inner = schemaOf(type.args[0] as TypeRef);
      return inner === null ? null : { kind: 'array', of: inner };
    }
    if (type.args.length > 0) return null;
    return SCALARS[type.name] ?? null;
  }

  /* An option is deliberately not expressible. "This argument may be absent" is a thing
     a model gets wrong constantly, and the language's no-implicit-null rule exists so a
     caller has to face it — handing that decision to a model gives it away. */
  return null;
}

function describeType(type: TypeRef): string {
  if (type.kind === 'primitive' || type.kind === 'named') {
    return type.args.length === 0
      ? type.name
      : `${type.name}<${type.args.map(describeType).join(', ')}>`;
  }
  return type.kind;
}
