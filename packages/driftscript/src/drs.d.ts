/**
 * What TypeScript knows about a `.drs` import, and what it honestly cannot.
 *
 * A consumer writing `import * as door from './door.drs'` needs the module to resolve. Without
 * this, it does not — which is the first thing anybody hits, and hitting it in the demo harness is
 * how it was found rather than shipped.
 *
 * **The generated exports are deliberately not declared, because TypeScript cannot know them.** A
 * `.drs` file's exports depend on what it declares, and discovering that means compiling it — which
 * is a language server's job and not a `.d.ts` file's. Declaring an index signature that claimed to
 * know them would be a lie a consumer would then build on.
 *
 * So this declares the one export every generated module has, and says nothing about the rest. A
 * consumer reaching a generated function casts through `Record<string, unknown>`, which is
 * uncomfortable on purpose: it is exactly as much type safety as exists today.
 *
 * **The fix is generated declarations**, one `.d.ts` per `.drs`, emitted by the transform. It is
 * not here because it needs a decision about where generated files live in a project that commits
 * none — and shipping a comfortable lie in the meantime would remove the pressure to make it.
 */
declare module '*.drs' {
  export const __drift: {
    readonly module: string;
    readonly requires: readonly string[];
    readonly shapes: Readonly<Record<string, readonly string[]>>;
    readonly schemas?: Readonly<
      Record<string, { readonly name: string; readonly fields: readonly unknown[] }>
    >;
  };
}
