# Changelog

DriftScript's version line. `driftscript` and `driftscript-language` move together, in that order;
the VSCode client carries its own number and is listed separately at the end.

**1.4.0 is the first version published to npm.** Everything before it was released inside the
private repository the language grew up in, and is recorded here so the number has visible support
rather than arriving as a package with a history nobody can find.

This file is the only copy. `npm run build` writes it into each package so it travels in the
tarball, and the copies are not committed — see `scripts/build.mjs`.

---

## 1.6.0

**Four gaps a consumer reported, and two bugs found while closing them.**

- **`List<T>`.** `[a, b]`, `xs[i]`, `len`, `push` and `for … in` are language forms rather than a
  module, so there is no `std/collections` — that entry was listed in `STD_MODULES` and in the
  language reference for as long as neither existed, and it is gone rather than filled in.
  **The list is invariant**: a `List<Wolf>` is not a `List<Dog>`, because with covariance a `Dog`
  could be pushed through a reference whose real list holds `Wolf`, and record subtyping is sound
  here partly because that cannot happen. An index past the end throws, for the reason integer
  overflow does. `push` needs a `mut` binding, because growing a list writes to the container.
- **`break` and `continue`.** No labels; a jump always means the loop it is written in. **A `break`
  out of a query loop finishes walking the cursor first** — the protocol generated code speaks has
  no release call, so a cursor is returned to the pool when `ecs.next` reports exhaustion and by no
  other route, and leaving early would keep one per frame.
- **Module constants.** A `let` at the top of a file, exported, and importable the way a function
  is. Its value is arithmetic over literals and other constants; a call cannot run before a module's
  host is bound. Declaration order carries no meaning, so they are emitted in dependency order and a
  cycle is refused naming every constant in it. `var` at this level is refused.
- **A component reached through a handle now compiles to a read.** `who.Placement.x` outside a query loop
  emitted `who.Placement.x` — a property of a number. It type-checked, it linked, and it threw the moment
  it ran; a helper taking an `Entity` and writing a component is a documented pattern that produced
  broken code, and nothing had executed one. It lowers to `ecs.read` and `ecs.write` instead, which
  is what a consumer was writing by hand with the component and field as strings — the same calls,
  with both names checked.
- **A capability may return `Entity`.** The registry path resolved the name to a primitive where a
  written annotation resolved it to the handle kind, so a host that returned a handle got a type on
  which `.Component` was refused with "`Entity` has no fields". The two resolvers disagreed about
  one word and only one of them had ever been exercised.
- **A system's declared access is added to its metadata**, not only checked against inference. A
  capability naming a component with a *string* is invisible to inference, so the component never
  reached the metadata and a host enforcing declared access refused the call at runtime — with no
  way for the author to grant it, because writing `reads Position` was checked and then dropped.

**Two things a consumer has to change.** A helper that reaches a component through a handle now
takes a `World` parameter, because that is what the read runs against; the form it replaces could
not run. And a `.drs` file that imported `std/collections` was already failing per name and now
fails at the module.

## 1.5.0

**`std/math` works at either float width, and floats have a conversion.** Both halves of one hole,
reported by a consumer who had already worked around it: `std/math` was single precision, a generic
ECS accessor is double, and nothing converted between them — `DS0232` said in words that a float had
no conversions at all.

- **`f32.nearest(v)` and `f64.nearest(v)`.** One spelling per float, where an integer gets three,
  because an integer narrowing has three intents the compiler must not choose between and a float
  conversion has one: IEEE rounds to the nearest representable value, in both directions. Widening
  is exact and still has to be written, because `LANGUAGE.md` promises there is no implicit widening
  and a promise with an exception is one a reader has to keep a list for.
- **A capability may declare a parameter or return as `float`**, meaning `f32` or `f64`, the same
  one throughout the call. The width is fixed by the first argument that has one; bare literals
  adopt it; a call where nothing fixes it is `f32`. Every `std/math` and `std/time` signature is
  written this way, so `math.clamp(v, 0, 1)` works whether `v` is single or double precision.
- **Rounding moved from the standard library's implementations to the call site.** These used to
  apply `Math.fround` to every result, which stopped being correct the moment a call could be at
  double precision — the code protecting precision would have been the code destroying it. The
  compiler now wraps an `f32`-resolved call and leaves an `f64` one alone. **A single-precision call
  emits the identical arithmetic it did before.**
- **Diagnostics point at the conversion that exists.** `DS0230` on two floats names
  `f32.nearest`/`f64.nearest` instead of the three integer spellings, which used to send a reader to
  `DS0232` and a dead end. `DS0263` on a float-to-float mismatch names the conversion and the width
  the call resolved to. `DS0233` covers a wrong conversion method on a float; no code was
  renumbered and none was added.
- **Refused at registration rather than at a call site:** a `float` return with no `float` parameter
  (nothing could fix the width, so every call would quietly be `f32`), a decorated `float` such as
  `float?`, and a host type named `float`.

**A `.drs` file that compiled under 1.4.0 compiles under 1.5.0, to the same JavaScript, with the
same diagnostics** — except that `f32.clamp(v)` now reports `DS0233` naming `nearest`, where it used
to report `DS0232` saying no conversion existed.

**For a host: implement a `float` capability once, in double, and do not round.** If you had copied
`std/math`'s old shape and were applying `Math.fround` inside your own implementations, that is
still correct for a signature you leave written `f32`, and wrong for one you change to `float`.

## 1.4.0

**The language is publishable, and this repository is what made it so.**

Everything below is one finding. `driftscript` was written in erasable TypeScript whose relative
imports name `.ts`, so that Node can type-strip the Vite plugin and the compiler it pulls in.
**Node refuses to strip types for any file under `node_modules`** — `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`,
a categorical refusal rather than a resolution failure. Inside a workspace the package resolves
through a symlink whose real path has no `node_modules` segment in it, so the refusal never fires.
From a tarball it fires on the first import.

Five of seven consumer paths were broken while every test passed, and no test in the suite could
have seen it.

- **Compiled output.** Both packages now ship `dist/` — JavaScript, declarations, and both kinds of
  source map — emitted by `tsc` with `rewriteRelativeImportExtensions`. `exports` points at it.
  `driftscript/vite`, `driftscript/compiler` and the language server load from a registry install.
- **`allowImportingTsExtensions` is no longer a requirement on you.** It was documented as "not
  optional" and it silently excluded every consumer whose build *is* `tsc`, because that flag is
  only legal alongside `noEmit` or `emitDeclarationOnly`. The build removed the requirement and the
  paragraph that explained it.
- **`driftscript/drs`.** One `/// <reference types="driftscript/drs" />` replaces the block of
  `declare module` the README used to ask you to copy out of it.
- **`driftscript/grammar.json`.** The TextMate grammar, generated from the compiler's token table,
  reachable by any editor that is not VSCode.
- **`driftscript-language` has a `bin`.** It shipped a server entry point with no way to start it.
  `npx driftscript-language --host ./capabilities.json` works.
- **No tests in the tarball.** Forty-four `.test.ts` files were 35.5% of the unpacked size, because
  neither manifest declared `files`. Both do now, as whitelists.
- **A licence in each package.** Both manifests said MIT and neither tarball carried the notice.
  MIT's own conditions require it to travel with the copy; a field is not the notice.
- **The manifests describe themselves.** `repository`, `homepage`, `bugs`, `keywords`, `author`,
  `engines`, and `exports` with type conditions.
- **`scripts/publish-check.mjs`.** Ten rows, run against a packed tarball in a clean room outside
  the workspace, because checking the workspace copy is what hid all of the above.

**No language semantics changed.** A `.drs` file that compiled under 1.3.0 compiles under 1.4.0, to
the same JavaScript, with the same diagnostics.

## 1.3.0

`drift/ai`. An agent's current slot is never empty: a deterministic policy floor runs inside the
simulation on the fixed clock and knows nothing about providers, and a one-slot buffer holds the
next model-authored intent while the current one executes. An agent with no provider configured
still behaves; a slow provider costs quality rather than motion. Nothing in a script awaits a
model.

## 1.2.0

**The entity forms.** `component`, `entity`, `system`, `query` and `prefab` are language forms
rather than library calls, `@editor` is checked against the field it annotates, and a query loop
compiles to a pooled cursor and a hoisted view — 30.4 ns per entity against 28.7 for the same loop
written by hand, and 388 for the host call per field it replaces.

`reads` and `writes` are inferred through the call graph and the declaration is checked against
them: a declaration that omits a write is refused by name, and one wider than the body is a warning.

## 1.1.0

`@deterministic` means something different, which is why this moved at all. Writing a component
through the entity model is inside the determinism boundary, so a movement system writing a
position is a deterministic function. A language change must not vanish inside a host's minor.

## 1.0.0

The language, complete.

Tasks compiled to a switch on an integer, the three clocks with the fixed one counting steps,
scopes that cancel what they own, typed events dispatched immediately, generic state machines,
stable field ids, migration across a shape change, and `@hot` checked rather than remembered.

Measured rather than asserted: generated code is indistinguishable from hand-written TypeScript at
3.58 ns against 3.57, a suspended task is 565 bytes, and half a million scheduler ticks over twenty
thousand tasks produced two garbage collections against a control's forty-eight.

Four surfaces are refused in writing rather than left as gaps.

## 0.2.0

Cross-module imports and record subtyping. A `.drs` file imports another `.drs` file, and a `data`
record extends another.

## 0.1.0

The language on its own version line: lexer, parser, type checker, effect checker, capability
registry, linker, a JavaScript backend whose source maps resolve to `.drs` positions, and the
generated TextMate grammar.

---

## The VSCode client

`driftscript-vscode` carries its own number because it ships to a different registry on a different
schedule. It is on the marketplace as `DriftTech.driftscript-vscode`.

### 0.2.0

**It can be installed by somebody who did not clone the repository**, which it could not before.

The client found its language server by walking up from its own file to the source in
`packages/driftscript-language`. From a real install that path lands in `~/.vscode` and finds
nothing, so the extension would have activated, started no server, and left every `.drs` file
looking like a language server with no opinions. That, rather than anything commercial, was the
reason it was unpublishable.

- The build emits `out/server.mjs` beside the client, and the client falls back to it. In a checkout
  the source still wins, so an edit to the server needs a window reload rather than a rebuild.
- `npm run vsix` produces an installable package: 12 files, 268 KB.
- `scripts/editors.test.mjs` builds that `.vsix`, unpacks it, spawns the server inside it and sends
  an LSP `initialize`. Two failures got through everything else before it existed — `vsce` refusing
  to package because a hoisted `node_modules` climbs out of the extension folder, and then a bundle
  that built cleanly and died on its first line with `Dynamic require of "node:util" is not
  supported`. Neither changed a type, a build or a unit test.
- `driftscript.host` has no default any more. It pointed at a file in the engine's repository, which
  does not exist here, so the warning it produced read as a broken extension rather than an
  unconfigured one.

This is the first version on the marketplace, published under `DriftTech`.

### 0.1.0

Diagnostics, completion, hover, semantic tokens and the generated grammar, all of them computed by
`driftscript-language`, which computes none of them either and calls the compiler.
