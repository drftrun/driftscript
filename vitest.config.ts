import { defineConfig } from 'vitest/config';

/**
 * Tests are colocated as `*.test.ts` beside the module they cover, in whichever package owns them,
 * and are typechecked by `npm run typecheck`.
 *
 * Node environment: the language is a compiler, a linker and a small runtime — there is nothing
 * here that draws. The one thing that is not covered by this suite is the Vite plugin's behaviour
 * inside a real bundler, which `scripts/publish-check.mjs` exercises against a packed tarball
 * because that is the only place the failure it guards against can happen.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts'],
  },
});
