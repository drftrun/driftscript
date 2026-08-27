import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost } from '../index.ts';

/**
 * What a generated module is allowed to contain at its top level.
 *
 * **This is the assertion the whole module-cycle design rests on.** An ES module cycle is dangerous
 * when a module reads an imported binding *during evaluation*, because one of the two necessarily
 * runs first and sees the other half-built. A generated DriftScript module cannot do that, and the
 * reason is exactly what it puts at top level:
 *
 * - `let` bindings for capability namespaces, assigned later by `__bind`
 * - `import` declarations, whose bindings are only ever read inside a function body
 * - `export function` declarations, which hoist before anything evaluates
 * - `export const <Enum> = Object.freeze({…})`, a literal that references nothing imported
 * - `export const __drift = {…}`, a JSON literal
 * - the integer helpers, which are plain function declarations
 *
 * - a task body and the state table, which are object literals whose members are method
 *   definitions, `null` and string literals — nothing in them is *evaluated* beyond allocating the
 *   object, so none of it can read an import
 *
 * Record defaults live inside `createX()` and run when called, not at load, and the language has no
 * top-level `let` at all.
 *
 * **So the safety is a property of this emitter, not a law**, and it would break silently: the day
 * somebody emits a top-level expression, every cycle in every consumer's project starts reading
 * half-built modules, and nothing else in this repository would notice. Hence a test over every
 * `.drs` this repository ships rather than a sentence in a design document.
 *
 * If this fails, the rule is what to defend and the list below is what to argue with — a generated
 * module that runs work at import time is a module whose behaviour depends on when it was loaded.
 */
const ALLOWED = [
  /^let [A-Za-z_$][\w$]*;$/,
  /^import \{[^}]*\} from '[^']*';$/,
  /^export function [A-Za-z_$][\w$]*\(/,
  /^function [A-Za-z_$][\w$]*\(/,
  /^export const [A-Za-z_$][\w$]* = Object\.freeze\(\{$/,
  /* A task body and the state table. Inert for the reason above, and the third test below is what
     keeps them inert rather than this pattern, which cannot see inside them. */
  /^export const [A-Za-z_$][\w$]* = \{$/,
  /^const \$states = \{$/,
  /^export const __drift = /,
  /* A closing brace, optionally closing a call and a statement — `}`, `};`, `})` and `});`. The
     last is how a frozen enum ends, and leaving it out is what this pattern got wrong first. */
  /^\}\)?;?$/,
  /^$/,
];

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

/*
 * Three calls, each spelled out in full — pattern *and* options.
 *
 * The bundler matches this in the syntax tree rather than running it, so neither argument may be a
 * variable: a pattern built from one reaches nothing and the suite passes having read no files,
 * and options held in a `const` fail outright with "Expected the second argument to be an object
 * literal". That is the same rule `AGENTS.md` records for `import.meta.hot.accept`, and it failed
 * here the same way — by looking like ordinary refactoring.
 *
 * The first test below counts what was found, because the silent half of that rule is the dangerous
 * one.
 */
const sources: Record<string, string> = {
  ...import.meta.glob('../../../../../docs/corpus/**/*.drs', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  ...import.meta.glob('../../../examples/*.drs', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  ...import.meta.glob('../../../../../demo/*.drs', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
};

/** Every `.drs` this repository ships: the design corpus, the examples, and the demo. */
function shipped(): { file: string; source: string }[] {
  return Object.entries(sources).map(([file, source]) => ({ file, source }));
}

/** Statements at column zero, which for this emitter is exactly the top level. */
function topLevelOf(code: string): string[] {
  return code.split('\n').filter((line) => !line.startsWith(' ') && !line.startsWith('\t'));
}

describe('a generated module’s top level', () => {
  it('reads every .drs this repository ships, so the corpus is not a token gesture', () => {
    /* If this ever finds nothing, every assertion below is vacuously true and the guard is gone. */
    /*
     * Eleven today: five corpus files, five examples, one demo. Asserted as a floor with the real
     * number in it rather than `> 0`, because this glob silently read six while one of its three
     * patterns pointed a directory too high — the suite passed, having skipped every example.
     */
    expect(shipped().length).toBeGreaterThanOrEqual(11);
  });

  it('contains nothing that could observe a half-built cycle', () => {
    for (const { file, source } of shipped()) {
      const result = compileDriftScript(source, {
        filename: file,
        mode: 'development',
        host: singleFileHost(),
      });

      /* A corpus file that does not compile alone is skipped rather than failed: several of them
         deliberately use surfaces no target provides, which the design intends and the
         whole reason those files are read rather than run. */
      if (result.code === '') continue;

      for (const line of topLevelOf(result.code)) {
        expect(
          ALLOWED.some((pattern) => pattern.test(line)),
          `${file} emits a top-level line this design does not allow:\n  ${line}`,
        ).toBe(true);
      }
    }
  });

  it('emits no top-level expression, which is the specific thing that would break a cycle', () => {
    /*
     * Stated separately from the allow-list because it is the failure mode rather than the rule. An
     * allow-list can be widened by somebody who reads it as bureaucracy; this one names what goes
     * wrong, so the next person has to disagree with a consequence rather than with a pattern.
     */
    for (const { file, source } of shipped()) {
      const result = compileDriftScript(source, {
        filename: file,
        mode: 'development',
        host: singleFileHost(),
      });
      if (result.code === '') continue;

      for (const line of topLevelOf(result.code)) {
        const assignment = /^(?:export )?(?:const|let|var) [A-Za-z_$][\w$]* = (.+)$/.exec(line);
        if (assignment === null) continue;
        const value = assignment[1];
        const inert =
          value.startsWith('Object.freeze({') ||
          value === '{' ||
          line.startsWith('export const __drift = ');
        expect(inert, `${file} evaluates something at load:\n  ${line}`).toBe(true);
      }
    }
  });

  it('puts nothing but methods and literals inside a top-level object', () => {
    /*
     * The allow-list above lets a task body and the state table through as `= {`, and cannot see
     * what is in them. This is what keeps that safe: **every member is a method head, a nested
     * object, `null` or a string** — so allocating the object reads nothing and calls nothing.
     *
     * The day somebody emits `enter: makeTask(…)` or `on: HANDLERS[name]`, a module in a cycle
     * starts doing work at load and this is the only thing that would notice.
     */
    const MEMBER = [
      /^[A-Za-z_$][\w$]*: null,$/,
      /^[A-Za-z_$][\w$]*: "(?:[^"\\]|\\.)*",$/,
      /^$/,
    ];

    for (const { file, source } of shipped()) {
      const result = compileDriftScript(source, {
        filename: file,
        mode: 'development',
        host: singleFileHost(),
      });
      if (result.code === '') continue;

      /*
       * A stack, because a method's *body* is code and code may do anything — it runs when called
       * rather than at load. Only the object's own members are the subject. Counting braces to
       * leave a body is crude and is enough here: generated code holds no brace in a string.
       */
      const stack: ('object' | 'method')[] = [];
      let bodyDepth = 0;

      for (const line of result.code.split('\n')) {
        const trimmed = line.trim();

        if (bodyDepth > 0) {
          bodyDepth += (trimmed.match(/\{/g) ?? []).length - (trimmed.match(/\}/g) ?? []).length;
          continue;
        }

        if (stack.length === 0) {
          if (/^(?:export )?const [A-Za-z_$][\w$]* = \{$/.test(trimmed)) stack.push('object');
          continue;
        }

        if (/^[A-Za-z_$][\w$]*\(.*\) \{$/.test(trimmed)) {
          bodyDepth = 1;
          continue;
        }
        if (/^[A-Za-z_$][\w$]*: \{$/.test(trimmed)) {
          stack.push('object');
          continue;
        }
        if (/^\}[,;]?$/.test(trimmed)) {
          stack.pop();
          continue;
        }

        expect(
          MEMBER.some((pattern) => pattern.test(trimmed)),
          `${file} puts something other than a method or a literal in a top-level object:\n  ${trimmed}`,
        ).toBe(true);
      }
    }
  });
});

describe('a file import', () => {
  it('binds no host namespace, because no host could supply one', () => {
    /*
     * `import { Wave } from "./shapes"` arrives as an ordinary ES import. A `let shapes;` assigned
     * from `$host["./shapes"]` is dead in every output that has one, and `bindModule` never looks
     * for it — it checks `drift/` requirements only. Found by reading what the dev server served.
     */
    const { code, diagnostics } = compileDriftScript(
      'import { Wave } from "./shapes"\n\ndata Pulse : Wave {\n    depth: f32 = 1\n}\n',
      {
        filename: 'p.drs',
        mode: 'development',
        host: {
          resolve: (specifier) => specifier,
          load: () => 'data Wave {\n    phase: f32 = 0\n}\n',
        },
      },
    );

    expect(diagnostics).toEqual([]);
    expect(code).not.toContain('$host["./shapes"]');
    expect(code).not.toContain('let shapes;');
  });
});
