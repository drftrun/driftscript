import { driftScript } from 'driftscript/vite';

/**
 * The demo harness, and the one place in this repository where the language is consumed the way a
 * consumer consumes it.
 *
 * **No manifest is configured**, so nothing links and nothing is refused. That is deliberate for a
 * harness: the page exists to look at behaviour, and a target manifest is a decision a real project
 * makes about what its build ships. `packages/driftscript/src/vite.test.ts` covers the refusal path,
 * and `scripts/publish-check.mjs` configures the checked path against an installed tarball, which
 * is the only place that check means anything.
 */
export default {
  plugins: [driftScript()],
};
