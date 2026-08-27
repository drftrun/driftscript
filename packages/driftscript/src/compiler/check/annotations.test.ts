/**
 * `@aiTool` and `@aiContext`, with schemas the checker generates.
 *
 * The schema comes from the signature the checker already validated, so it cannot drift
 * from the implementation — which is what makes this different from writing a prompt
 * that describes some functions.
 */
import { describe, expect, it } from 'vitest';
import { checkAiAnnotations } from './annotations.ts';
import { parse } from '../parser.ts';
import type { FnDecl } from '../ast.ts';

function functionsOf(source: string): readonly FnDecl[] {
  const { module, diagnostics } = parse(source, 'test.drs');
  const syntax = diagnostics.filter((d) => d.severity === 'error');
  expect(syntax.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  return module.decls.filter((d): d is FnDecl => d.kind === 'fn');
}

function check(source: string) {
  return checkAiAnnotations(functionsOf(source), 'test.drs');
}

describe('@aiTool', () => {
  it('generates an object schema from the signature', () => {
    const result = check(
      '@aiTool(description: "Inspect an object.")\nfn inspect(target: String, radius: f32) {\n}\n',
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.schema).toEqual({
      kind: 'object',
      fields: { target: { kind: 'string' }, radius: { kind: 'number' } },
    });
  });

  it('carries the description through', () => {
    const result = check('@aiTool(description: "Inspect an object.")\nfn inspect(t: String) {\n}\n');

    expect(result.tools[0]?.description).toBe('Inspect an object.');
  });

  it('collapses every numeric width to number', () => {
    const result = check(
      '@aiTool(description: "d")\nfn f(a: u8, b: i64, c: f32, d: f64) {\n}\n',
    );

    /* The language keeps the distinction and re-checks it at the call. The schema is
       what the *model* is told, and telling it `u8` would be telling it something no
       provider enforces. */
    const schema = result.tools[0]?.schema;
    expect(schema?.kind).toBe('object');
    if (schema?.kind === 'object') {
      for (const field of Object.values(schema.fields)) expect(field.kind).toBe('number');
    }
  });

  it('expresses an array of a scalar', () => {
    const result = check('@aiTool(description: "d")\nfn f(tags: Array<String>) {\n}\n');

    const schema = result.tools[0]?.schema;
    if (schema?.kind === 'object') {
      expect(schema.fields.tags).toEqual({ kind: 'array', of: { kind: 'string' } });
    }
  });

  it('refuses a parameter no schema can express, naming it and its type', () => {
    const result = check('@aiTool(description: "d")\nfn f(node: Node) {\n}\n');

    expect(result.diagnostics.map((d) => d.code)).toContain('DS0287');
    expect(result.diagnostics[0]?.message).toContain('node');
    expect(result.diagnostics[0]?.message).toContain('Node');
    /* And nothing is registered. A tool whose arguments cannot be validated is not a
       tool that should be offered with one argument missing. */
    expect(result.tools).toEqual([]);
  });

  it('refuses an option, because absence is the caller decision to face', () => {
    const result = check('@aiTool(description: "d")\nfn f(target: String?) {\n}\n');

    expect(result.diagnostics.map((d) => d.code)).toContain('DS0287');
  });

  it('refuses a tool with no description', () => {
    const result = check('@aiTool\nfn inspect(t: String) {\n}\n');

    expect(result.diagnostics.map((d) => d.code)).toContain('DS0286');
    /* A description is the only thing telling a model *when* to reach for this. A tool
       without one is a tool it calls at random or never. */
    expect(result.diagnostics[0]?.message).toContain('description');
  });

  it('leaves an unannotated function alone', () => {
    const result = check('fn ordinary(node: Node) {\n}\n');

    expect(result.diagnostics).toEqual([]);
    expect(result.tools).toEqual([]);
  });
});

describe('@aiContext', () => {
  it('registers a context provider with its description', () => {
    const result = check(
      '@aiContext(description: "Objects currently relevant.")\nfn visible() {\n}\n',
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.contexts).toEqual([
      { name: 'visible', description: 'Objects currently relevant.' },
    ]);
  });

  it('refuses one with no description', () => {
    const result = check('@aiContext\nfn visible() {\n}\n');

    expect(result.diagnostics.map((d) => d.code)).toContain('DS0286');
  });

  it('does not require its parameters to be schema-expressible', () => {
    /* Context is *sampled*, never asked for. The model reads what a context provider
       returns; it never supplies its arguments, so nothing here has to be expressible
       in a schema the way a tool's arguments do. */
    const result = check('@aiContext(description: "d")\nfn visible(node: Node) {\n}\n');

    expect(result.diagnostics).toEqual([]);
    expect(result.contexts).toHaveLength(1);
  });
});
