# DriftScript

A strict, deterministic-aware, hot-reloadable scripting language for consumer-authored behaviour.

`.drs` source is compiled by **your** toolchain to JavaScript ES modules with source maps, and
loaded through a small runtime. It has explicit host bindings, compiler-checked effects, structured
cancellable tasks, and state that survives a reload.

```sh
npm i driftscript
```

Zero runtime dependencies. `npm ls driftscript` shows one package, and that is a claim you can check
in ten seconds, not one you have to take on trust.

- **Guide, reference and playground:** [script.driftengine.dev](https://script.driftengine.dev)
- **The language reference:** [`docs/LANGUAGE.md`](docs/LANGUAGE.md)
- **Runnable examples:** [`examples/`](examples/), every one of them compiled by a test

## The language outlives its first host

**DriftScript is a reusable language, and [DriftEngine](https://driftengine.dev) is its first host.**

That is a structural claim, not a slogan. This package depends on nothing: no engine, and not
even for a type — and three separate mechanisms in
[its repository](https://github.com/drftrun/driftscript) fail if that stops being true:

| Mechanism | What it catches |
|---|---|
| `scripts/boundaries.test.mjs` | an import or a declared dependency reaching a foreign package, type-only ones included |
| `scripts/version.test.mjs` | the language drifting onto somebody else's version line |
| `scripts/size-gate.test.mjs` | the runtime fixture failing to bundle with no host present |

What that buys you: everything under `std/` works in any host, and everything under a host's own
prefix is that host's. The prefix in an import tells you which you are looking at.

## Hello world

```drs
fn hello() -> String {
    return "hello, world"
}
```

Nothing in that file needs a host. It compiles, and it runs, against a target that provides no
capabilities at all.

## The two prefixes

```drs
import { clamp } from "std/math"      // the language's own. Pure. Every host.
import { play } from "drift/audio"    // a host's. Has an effect. That host.
```

A target declares which non-`std` modules it provides. A module it does not provide is **refused at
link time, in words** — naming the module, the target, and whether the capability exists in that
host at all. A `.drs` file using an unprovided surface still parses and still type-checks; only
linking declines it.

An imported name is reached through its module: `import { play } from "drift/audio"` is called as
`audio.play(…)`, and `import { clamp } from "std/math"` as `math.clamp(…)`. The import is what makes
the name available and what the linker checks; the prefix is what you write.

## Entities are language forms, not library calls

```drs
component Health {
    current: f64 = 100
    maximum: f64 = 100
}

entity Animal {
    require Health
    var target: Entity?
}

system Hunger {
    writes Health

    update at 1Hz {
        for a in query<Animal>().without<Resting>() {
            a.Health.current = a.Health.current - 1
        }
    }
}

prefab Guard {
    Health { current: 60 }
}
```

**`reads` and `writes` are checked, not documentation.** The compiler infers what a system touches —
through the functions it calls, not only its own body — and refuses a declaration that omits a
write, naming the system and the component. A declaration *wider* than the body is a warning
instead, because widening deliberately is sometimes what an author means. A system that declares
neither is fully described by the inference and says nothing about itself.

**A query needs a world in scope.** A `system` has one, bound as `world`; a `fn` or `task` has one
when it declares a `World` parameter. There is no implicit argument anywhere, and a query loop with
no world is refused saying so.

**A query loop may not `await`.** Its cursor comes from a pool and is given back when the loop ends,
so a suspension would hold one across a frame where the result is already invalid.

The forms need a host that provides `drift/ecs`, and a `.drs` file using them requires that module
whether or not it imports anything from it — the form *is* a use of the capability.

## Adding it to a project

```ts
// vite.config.ts
import { driftScript } from 'driftscript/vite';
export default { plugins: [driftScript()] };
```

**That configuration checks nothing, and it is the right one for a first look and the wrong one for
a build that ships.** With no capabilities and no manifest the plugin infers no effects and refuses
no unprovided module, so `@deterministic` is a claim nothing verified and a script may call a
surface the target does not have. It will not resolve `std/math` either, because with no registry
there is nothing to resolve it against.

Turn both on by describing your host:

```ts
// vite.config.ts
import { createRegistry, defineTarget } from 'driftscript';
import { registerStd } from 'driftscript/std';
import { driftScript } from 'driftscript/vite';

const registry = createRegistry();
registerStd(registry);
// …and your own `defineCapability` calls, or `registryFromJson` on a file your host generates.

export default {
  plugins: [
    driftScript({
      registry,
      manifest: defineTarget('my-game', ['drift/ecs', 'drift/audio', 'drift/input']),
    }),
  ],
};
```

**A bundler config is loaded by Node before any bundler exists**, so whatever it imports has to be
loadable by Node. This package is, deliberately: it ships compiled JavaScript with declarations
beside it. A host whose own packages are not — extensionless relative imports are the usual reason —
cannot be imported here at all, and for that case the plugin takes its registry as **data**:

```ts
driftScript({
  capabilities: fileURLToPath(import.meta.resolve('my-host/capabilities.json')),
  manifest: { name: 'my-game', provides: ['drift/ecs'] },
})
```

A registry *describes and never invokes*, so nothing in a definition is a function and all of it
survives a process boundary. `serializeRegistry` writes that file and `registryFromJson` reads it
back. The language server reads the same file, for the same reason.

Passing both `registry` and `capabilities` is refused. Neither one silently wins.

### A capability that works at either float width

A parameter or return written `float` means **`f32` or `f64`, the same one throughout the call**:

```ts
defineCapability({
  module: 'drift/ecs',
  name: 'lengthOf',
  signature: 'fn(x: float, y: float) -> float',
  params: [{ name: 'x', type: 'float' }, { name: 'y', type: 'float' }],
  returns: 'float',
  effects: ['pure'],
  deterministic: true,
  doc: 'The length of a vector.',
  implementation: 'drift.ecs.lengthOf',
});
```

The width is fixed by the first argument that has one; bare literals take whatever that turns out to
be; a call where nothing fixes it is `f32`. So this widens what a signature accepts without adding a
coercion anywhere — an `f32` still does not become an `f64` by itself, and a call mixing both widths
is refused with `f32.nearest` named as the fix.

**Implement it once, in double, and do not round.** The compiler wraps an `f32`-resolved call in
`Math.fround` and leaves an `f64` one alone, because only it knows which width the call resolved to.
`std/math` and `std/time` are written this way and are the worked example.

A parameter or return may also be written `List<T>` — a navigation capability answering a path is
what that is for. `Result<T, E>` is deliberately not accepted across the boundary: a capability that
can fail has an option and an effect to say so with.

A `float` return needs at least one `float` parameter, since otherwise nothing could fix the width;
`defineCapability` refuses that at registration rather than letting every call quietly resolve to
`f32`.

### Telling TypeScript what a `.drs` import is

```ts
/// <reference types="driftscript/drs" />
```

One line, in any file your `tsc` project includes. It declares the module shape for `*.drs`, and
what it deliberately does **not** declare is the generated exports: a `.drs` file's exports depend
on what it declares, and discovering that means compiling it. So a generated function is reached
through `Record<string, unknown>`, which is uncomfortable on purpose — it is exactly as much type
safety as exists today.

### Driving the runtime

```ts
import { loadModule, setClockSource, tickTasks } from 'driftscript';
import * as door from './door.drs';

setClockSource({ fixedSteps: () => steps, fixedStep: () => 1 / 60, frame: () => t, wall: () => t });
const module = loadModule(door as unknown as Record<string, unknown>);
// in simulate(): tickTasks();
```

`setClockSource` comes **before** `loadModule` if the file declares a task: a spawn runs its task up
to the first await, and an await asks the clock what step it is on.

## Entry points

```text
driftscript            the runtime      ships to a browser
driftscript/std        the standard library, for a host to register
driftscript/compiler   the compiler     build side only
driftscript/vite       the transform    build side only
driftscript/drs        the *.drs ambient declaration
driftscript/grammar.json   the TextMate grammar, generated from the compiler's token table
```

**The compiler never reaches a production browser bundle.** The `exports` map is what lets a bundler
drop it, and a size gate in the repository is what proves it did.

`driftscript/std` is what a host calls to register the standard library into its own registry —
`registerStd(registry)` and `stdImplementations()`. It belongs to the host, not to a script: a
script reaches `std/math` through an import, and this is how the functions behind that import get
there. A target may not decline any of it, which is what "standard" means.

`driftscript/grammar.json` is there so an editor that is not VSCode does not have to re-derive the
language's keywords by reading the lexer. The VSCode client is in the same repository.

## What it costs

447 kB packed, 2.0 MB unpacked, because the tarball carries compiled JavaScript, declarations,
source maps and the source those maps point at. The runtime a browser actually receives is a few
kilobytes gzipped — the compiler is behind its own entry point and a production bundle drops it.

## Version

`driftscript` and `driftscript-language` move together, in that order, and nothing else moves them.
An engine release does not, because an engine version must never quietly redefine what a language
means. See [the changelog](CHANGELOG.md).

## Licence

MIT. See [`LICENSE`](LICENSE).
