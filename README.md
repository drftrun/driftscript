# DriftScript

**A scripting language for 3D engines that ships without one.**

`.drs` source compiles to JavaScript ES modules with source maps and runs through a small runtime.
It has explicit host bindings, compiler-checked effects, structured cancellable tasks, and state
that survives a hot reload.

```sh
npm i driftscript
```

Zero runtime dependencies. `npm ls driftscript` shows one package.

- **Guide, reference and playground:** [script.driftengine.dev](https://script.driftengine.dev)
- **The language reference:** [`packages/driftscript/docs/LANGUAGE.md`](packages/driftscript/docs/LANGUAGE.md)
- **The rules a change has to clear:** [`AGENTS.md`](AGENTS.md), and [`CONTRIBUTING.md`](CONTRIBUTING.md) for a first patch

```drs
fn hello() -> String {
    return "hello, world"
}
```

That file needs no host at all. It compiles, and it runs, against a target that provides no
capabilities.

## The claim, and the three things under it

**DriftScript is a reusable language, and [DriftEngine](https://driftengine.dev) is its first
host.** Three things hold that up, and you can check all of them yourself.

**The dependency tree.** `driftscript` depends on nothing. No engine, and not even an engine type.
`npm ls driftscript` settles it in ten seconds.

**The refusal.** Ask for a capability the host never provided and the linker declines in words. It
names the module, it names the target, and it says which of two situations you are in: no host
implements that module yet, or one does and your target did not ship it. A `.drs` file using an
unprovided surface still parses and still type-checks. Only linking declines it.

**The enforcement.** Three separate mechanisms fail if the language ever reaches into a host:

| Mechanism | What it catches |
|---|---|
| [`scripts/boundaries.test.mjs`](scripts/boundaries.test.mjs) | an import or a declared dependency reaching a foreign package, type-only ones included |
| [`scripts/version.test.mjs`](scripts/version.test.mjs) | the language drifting onto somebody else's version line |
| [`scripts/size-gate.test.mjs`](scripts/size-gate.test.mjs) | the runtime fixture failing to bundle with no host present |

That is the difference between an architecture and a README.

## What is here

| | |
|---|---|
| [`packages/driftscript`](packages/driftscript) | The language. Lexer, parser, type and effect checkers, IR, JavaScript emitter, capability registry, linker, runtime, Vite plugin. Published as [`driftscript`](https://www.npmjs.com/package/driftscript) |
| [`packages/driftscript-language`](packages/driftscript-language) | The language server. It calls the compiler and re-implements no part of it. Published as [`driftscript-language`](https://www.npmjs.com/package/driftscript-language) |
| [`editors/vscode`](editors/vscode) | The VSCode client. Contains no language logic. On the marketplace as [`DriftTech.driftscript-vscode`](https://marketplace.visualstudio.com/items?itemName=DriftTech.driftscript-vscode) |
| [`docs/corpus`](docs/corpus) | `.drs` files written to be read: what a language designer imagines people write, compiled by a test so the imagination stays honest |
| [`demo`](demo) | A page where a `.drs` file hot-reloads with the state it operates on intact |

## The two prefixes

```drs
import { clamp } from "std/math"      // the language's own. Pure. Every host.
import { play } from "drift/audio"    // a host's. Has an effect. That host.
```

A target declares which non-`std` modules it provides. The prefix in an import tells you which side
of the line you are on, and the standard library is the side a target may not decline.

## Entities are language forms

```drs
component Health {
    current: f64 = 100
    maximum: f64 = 100
}

system Hunger {
    writes Health

    update at 1Hz {
        for a in query<Animal>().without<Resting>() {
            a.Health.current = a.Health.current - 1
        }
    }
}
```

**`reads` and `writes` are checked, not documentation.** The compiler infers what a system touches,
following the functions it calls and not just its own body, and refuses a declaration that omits a
write, naming the system and the component. A declaration wider than the body is only a warning,
because widening deliberately is sometimes what an author means.

A query loop compiles to a pooled cursor and a hoisted view: 30.4 ns per entity, against 28.7 for
the same loop written by hand and 388 for the host call per field it replaces.

## Working on it

```sh
npm ci
npm run build          # emits packages/*/dist
npm run extension      # bundles the VSCode client and its server
npm test               # the language
npm run test:scripts   # the gates
npm run typecheck
npm run demo
```

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the bar a change has to clear, and the list of things that
get refused, written down in advance so nobody meets one in review.

## Relationship to DriftEngine

[DriftEngine](https://driftengine.dev) is a closed 3D engine, and it is DriftScript's first host —
the one every `drift/*` module in the corpus is written against. **It is not required and it is not
available.** Everything in this repository works without it, which is the point of the seam and the
reason three tests guard it.

A host describes itself to the language as data: a set of capability definitions and a manifest
saying which modules a build provides. `serializeRegistry` writes that description and
`registryFromJson` reads it back. Nothing in the mechanism is engine-shaped.

## Licence

MIT. See [`LICENSE`](LICENSE).
