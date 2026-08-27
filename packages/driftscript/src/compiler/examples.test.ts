import { describe, expect, it } from 'vitest';
import { compileDriftScript, formatDiagnostic, singleFileHost} from './index.ts';
import { defineTarget } from '../registry/manifest.ts';

/**
 * Every example in `examples/` compiles, and the documentation cannot rot.
 *
 * The examples exist to be read — by somebody learning the language, and eventually by a
 * documentation site generated from them. A page of examples that stopped compiling is worse than
 * no page: a reader debugs their own correct program against prose that was true once.
 *
 * So the examples are *inputs to a test* rather than illustrations beside one. When a language
 * change breaks one, this fails with the compiler's own diagnostic, at the file and line, in the
 * commit that caused it.
 *
 * **They are compiled against a target that provides nothing.** Every example uses only the
 * language, so it must link with no host at all — the same claim `driftscript-runtime-only` makes
 * about the runtime, checked from the source side.
 *
 * **Loaded through `import.meta.glob` rather than `node:fs`**, because `tsconfig.json` sets
 * `"types": []` so that `process`, `Buffer` and `require` cannot compile inside a package. The rule
 * exists to keep Node out of a consumer's bundle and it applies to a test in the same directory.
 * `demo/scenes.test.ts` reads its own inputs the same way and for the same reason.
 */
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

/*
 * Spelled out rather than built from a variable, because Vite replaces this call by matching it in
 * the syntax tree — the same rule that governs `import.meta.hot.accept`. A pattern assembled at run
 * time resolves to nothing and the suite passes having read no files.
 */
const sources = import.meta.glob('../../examples/*.drs', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const files = Object.entries(sources)
  .map(([path, source]) => [path.split('/').pop() as string, source] as const)
  .sort((a, b) => a[0].localeCompare(b[0]));

describe('the examples', () => {
  it('finds them, so an empty directory is a failure rather than a pass', () => {
    /* A glob that reaches nothing is a suite that measures nothing and reports green — the failure
       `docs-api.mjs` had for as long as there was more than one package. The count is asserted so
       that moving the directory fails here rather than quietly testing zero files. */
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files.map(([name]) => name)).toContain('hello.drs');
  });

  it.each(files)('%s compiles clean against a target that provides nothing', (name, source) => {
    const result = compileDriftScript(source, {
      filename: name,
      manifest: defineTarget('nothing', []),
      host: singleFileHost(),
      mode: 'development',
    });

    if (result.diagnostics.length > 0) {
      throw new Error(
        `${name} does not compile:\n\n` +
          result.diagnostics.map((d) => formatDiagnostic(d, source)).join('\n\n'),
      );
    }

    expect(result.code).not.toBe('');
  });

  it.each(files)('%s generates code a browser can load', async (name, source) => {
    const { code } = compileDriftScript(source, { filename: name, host: singleFileHost(), mode: 'development' });

    for (const forbidden of ['require(', 'process.', '__dirname', 'Buffer', 'node:']) {
      expect(code).not.toContain(forbidden);
    }

    /* Importing it is what proves it is syntactically valid JavaScript. A test that only greps the
       output passes on code no engine would accept. */
    const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${btoa(code)}`);
    expect(module.__drift.module).toBe(name);
  });
});
