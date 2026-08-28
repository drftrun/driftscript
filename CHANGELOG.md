# Changelog

DriftScript's version line. `driftscript` and `driftscript-language` move together, in that order;
the VSCode client carries its own number and is listed separately at the end.

**1.4.0 is the first version published to npm.** Everything before it was released inside the
private repository the language grew up in, and is recorded here so the number has visible support
rather than arriving as a package with a history nobody can find.

This file is the only copy. `npm run build` writes it into each package so it travels in the
tarball, and the copies are not committed — see `scripts/build.mjs`.

---

## 1.10.0

**Nine semantic passes each carried their own recursive walk over the compiler's tree, and every one
of them ended in a permissive default — so a node kind a pass did not name was skipped in silence.**
A source review asked whether `@hot` was complete. It was not, and neither was anything else built
the same way: five programs compiled clean and failed at run time, and two inference passes let
`@deterministic` and a system's declared access pass for code that violated both.

The five, all of which shipped:

- a task local read inside `[a, b]` or `xs[i]` emitted a bare identifier — a `ReferenceError` on the
  first resume that reached the line;
- a `let` inside a `for` loop in a task was written to the frame and read from a scope;
- an `emit` inside a `for` loop compiled to `$rt.emit(…)` in a module that declared no `$rt` and
  exported no `__runtime`;
- a `?` inside a `for` loop or a `scope` left its function unwrapped, so the internal carrier object
  escaped instead of becoming an `Err`;
- `@hot` accepted a list literal, an allocation anywhere in a loop body, and anything reached
  through a condition, an `ifLet` subject, an index subscript, a spawn argument or an event payload.

`ir/walk.ts` and `astWalk.ts` are the one description of what a node contains now, both exhaustive
on `never`. A pass that only recurses asks them and names no kind, so a node added later is walked
correctly without it changing; a pass making a claim about a kind — what allocates, how to rebuild a
node — keeps its own switch and ends it on `never`, because a claim has no safe default.
`walkers.test.ts` asserts the matrix by nested position rather than by feature.

**`await` inside `for … in` used to throw a bare internal error from the emitter, and now it
works.** The cutter splits a list loop the way it already split a `while`, with the list and the
index on the frame. A `continue` lands on the increment rather than the loop head, because one that
jumped to the head would re-bind the same element for ever — a task alive, resuming, and making no
progress. A query loop still refuses to suspend, and now refuses however deeply the `await` is
nested.

**`i64` and `u64` claimed a range the backend cannot represent.** A JavaScript number is a double:
exact to `2^53 - 1` and no further. The bounds were computed as `2 ** 64 - 1`, which *is* `2^64` as
a double, so nothing was ever outside a `u64` and sums went on running with bits already lost. Their
domain is now `-(2^53 - 1) … 2^53 - 1` and `0 … 2^53 - 1`; the nominal width still means what it says
wherever a value is stored, which is why the types stay. Wrapping is refused on both by name, since
two values near the top add to almost `2^54` where the sum is rounded before anything can reduce it;
checked and saturating arithmetic are untouched. A literal is now checked against its type at every
width — `let n: u8 = 300` compiled before this — and a negative literal is checked after its sign is
applied, which was wrong in both directions.

**A live task is rebound only when its frame and its resume points agree.** A suspended task was
being handed to new code on its exported name alone. Each task now emits its frame layout and the
shape of its suspensions, and `patchModule` plans every live task before the first write and refuses
atomically. Body edits, duration changes and added or removed locals are carried; a type change or a
moved `await` is refused, naming what it is. The package README has the table.

**`typeKey` returned `type.kind` for anything it did not special-case**, so every integer width keyed
as `int`, every enum as `enum` and every list as `list` — and callers compare it for equality. A
migration would carry a `u8` into an `i64`, an interface change from `u8` to `i64` hashed identically,
and, because a component field's type is this string while a host's column table is keyed by the
width, **every integer component field threw at bind**. Nothing in the corpus declares one, which is
why it stood.

**A module specifier is serialised rather than quoted.** The parser keeps whatever sits between the
quotes and a filesystem host resolves it as a path, so a directory holding an apostrophe produced
generated JavaScript that would not parse. `AGENTS.md` carries the rule this generalises to.

**A `mode: 'production'` build is refused without a manifest and a registry**, unless
`verification: 'none'` says it is deliberately unverified. Without them nothing links and
`@deterministic` is a claim nothing checked, and that was the shortest working config. Development is
unchanged.

**The fixed simulation step is a target's, not the parser's.** `CompileOptions.fixedStepsPerSecond`
defaults to 60; `DS0133` lists the rates that divide *your* step, and the value a module was built
with rides in its metadata, so a module cached at 30 and loaded by a host running at 60 can be told
apart from one built for it.

`SECURITY.md` now separates capability enforcement from execution isolation: the model controls what
a script may *name*, and gives no CPU budget, no memory quota and no containment. Untrusted content
belongs in a Worker with capabilities passed across it.

---

## 1.9.0

**The compiler and a host's runtime gave opposite instructions about the same line, and this one
followed the compiler.** A component named in `query<…>` is a component a host is handed: the engine
that reported this refuses a query unless every component in it is declared in `reads` or `writes`,
because a schedule derived from declarations is wrong the moment a system touches more than it says.
The access analysis here walked a loop's *body* and never its *terms*, so a component that appears
in a query and nowhere else was invisible to it — and `DS0291` called the declaration the host
demanded unused.

**Following that advice produced a module that compiled clean and threw once a tick.** It was found
from play rather than from a check: the throw lands inside the host's schedule, so every system
after it stops, and what the reporter saw was a *different* system stuttering — a vehicle moving in
jerks — with the only evidence in a browser console no headless gate reads.

Two diagnostics change direction together. `DS0291` no longer calls a query's own declaration
unused, and **`DS0288` now refuses the omission**, which moves the failure from once-per-tick at
runtime to once at compile time. A `with` term counts, because it reaches the same host call; a
`without` term does not, because an exclusion never looks inside a component and an entity it
matched is not in the result at all. An `entity` term expands to everything it stands for, its own
implicit component included, since that is what the host is handed.

**A minor rather than a patch, because a build that was green can go red.** A module querying a
component it never declared is refused now. That module was already broken — it would have thrown in
any host that checks — but the day it starts failing is a day a consumer can name.

This repository's own fixture was one of them: `entityMeta.test.ts` compiled a system that queried
an entity and declared only one of its components, which is to say it had been asserting the shape
of metadata for a module that could not run.

## 1.8.1

**1.8.0 emitted a field it did not declare, and the first host to read it found out.** A system's
`uses` clauses reach the generated metadata — that is the whole point of them, since a host has to
know what to supply — but `DriftSystemInfo`, the type a host reads that metadata back through, never
gained the field. The data shipped; TypeScript denied it existed; a consumer needed a cast to reach
what the release was for.

**The fix is that there is one description now instead of two.** `EntityMetadata` restated
`DriftModuleInfo`'s shapes by hand, and the two agreed only because neither had moved. The compiler's
half is written in terms of the runtime's types now, so a field added to one is a compile error in
the other until it is populated. `uses` is optional there, because a module compiled before 1.8.0
has none and a runtime that threw on one would refuse to load a module that works.

Nothing a script can write changed, and no emitted byte moved.

## 1.8.0

**A system can be handed something, which is the half of an entity's world a script could not
reach.** A consumer reported it: an opaque handle — a route, a behaviour tree, an input map —
enters a script only as a capability parameter, so a `fn` can take one and a `system` can take
nothing at all. What that cost was the loop. The host kept a route per agent and called a plain
function once per agent per step, so the rule stayed in the script and hot-reloadable while the walk
over entities moved out — out of the schedule, out of the declared-access checks, and out of step
with the query it replaced, by hand.

```drs
system Walk {
    uses graph: NavGraph
    writes Placement

    update {
        for e in query<Placement>() {
            let path = navigation.pathOf(graph, e)
            e.Placement.speed = navigation.remaining(path)
        }
    }
}
```

- **`uses name: Type` in a system's head**, beside `reads`, `writes` and `after`. The type is one a
  host registered, resolved exactly as a parameter's is, so an unknown name refuses in the same
  words rather than one path quietly succeeding. The binding is immutable: the host owns the value
  and a script passes it back rather than looking inside it.
- **A resource is one per type**, and the type is what a host is asked for — so two systems naming
  the same type differently are handed one object, and a script renaming its own binding changes
  nothing outside its file. Two clauses of one type in one system are refused as what they are: two
  names for one thing.
- **A system with no `uses` generates exactly the function it always did.** The second parameter
  appears only where something reads it, so a host may pass it to every system unconditionally and
  no shipped module gains a byte.
- **The metadata says what to supply.** Each system carries its resources by name and type, always
  present and empty where there are none — the rule the four entity lists already follow, so a host
  reads a field rather than testing for one.

**The other shape this could have taken is refused, and the reason is recorded beside the
declaration.** A component field holding a handle was the first thing the report asked for, and a
component is what a save file holds: its schema carries stable field ids, a prefab gives every field
a constant, and a scene load rewrites its entity columns. A host's object satisfies none of the
three, so that field would be the one part of a component that silently does not persist.

**A handle per entity comes from a capability**, which may already return a host type — the host
keeps the table, the script keeps the rule.

**`uses` is a soft keyword**, so `data Stats { uses: i32 }` and `fn count(uses: i32)` go on parsing.

**The editor client has to be re-cut for this one.** A 1.7.0-era bundled server meets `uses` and
answers `DS0133` against the whole system declaration, which is a valid document going red — the
first of the two cases in `docs/RELEASING.md`, and it was measured rather than assumed.

## 1.7.0

**Preparation, so that building a host surface needs no language release.** Three things stood
between a host and shipping a track it had already designed.

- **The linker asks the registry which modules a host describes**, where it used to consult a
  hardcoded set of *unshipped* module names — one host's roadmap, inside a package that may not know
  a host exists, which had to shrink every time that host shipped one. A host could not bind a module
  until the language cut a release removing the name, and the host's own suite asserted the two
  lists agreed in both directions.
- **What replaced it is a catalogue that never shrinks**: every `drift/*` surface the language
  specifies, built or not. That is language knowledge and always was — `LANGUAGE.md` prints these
  and the parser knows the prefix — and it keeps the half of the old list that mattered: a script
  written against a surface nothing implements is told **the module is specified and the file is
  valid**, rather than reading as though the language were broken. Together the two give three
  refusals instead of two, and the third is new: **a misspelled module is named as one**, with the
  near name suggested. It used to be told to add a module that does not exist to a manifest.
  `UNSHIPPED_MODULES` is replaced by `SPECIFIED_MODULES`.
- **A capability may name `List<T>`.** A navigation capability answers a path, and a `TypeName`
  could carry no parameterised form — so a host had the choice of a count-and-index pair of
  capabilities, or keeping the logic in its own language, which is the thing a script is for.
  `Result<T, E>` is still refused across the boundary: nothing has asked for one, and a capability
  that can fail has an option and an effect to say so with.
- **`behavior.read` and `behavior.write` exist.** `drift/behavior` was the one specified surface
  with no effect name at all, so a host could not register a capability for it — `defineCapability`
  requires at least one, and borrowing `ecs.*` would have described a behaviour tick as an entity
  write. `behavior.read` is inside the determinism boundary; the write is deferred with the other
  subsystem writes, **and that is not a blocker**: a host ships the track with
  `deterministic: false` and moving the effect inside is one line on the day somebody can answer for
  its replay behaviour.

**Nothing a script can write changed.** A `.drs` file that compiled under 1.6.0 compiles under
1.7.0, to the same JavaScript. What changed is what a *host* may describe, and what a refusal says.

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
- **A function can take a row of a component.** `fn advance(m: mut Placement, dx: f64)`, called as
  `advance(e.Placement, 1)` — the signature says which component the helper touches, `mut` says whether it
  writes, and the caller's system is checked to have declared it. A row lowers to a world and a
  handle, so the body's `m.x` is the same `ecs.read` a handle access is.
- **A component row is not a value, and now it is refused as one.** `entities.ts` had asserted that
  in a comment since the entity model shipped and nothing enforced it, so `let m = e.Placement` compiled
  to a property read of a number. Holding one or returning one is an error naming the two things a
  row can do.
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

### 0.5.0

**A re-cut, because the server a 0.4.0 client carries refuses code 1.10.0 accepts.** `await` inside
a `for … in` is the visible one: the bundled 1.9.0 compiler does not merely report it, it *throws*
from the statement emitter, so a file containing one gets no diagnostics at all rather than wrong
ones. The integer literal checks and the wrapping refusal are the other direction — a 0.4.0 client
stays quiet about `let n: u8 = 300`, which the language now refuses.

- The server is a 1.10.0 one.
- Nothing in the client changed. **The version moves because what it carries did**, for the fourth
  time and for the same reason.

### 0.4.0

**A re-cut, because 1.8.0 added a keyword and a bundled server that has never heard of it goes red
on the whole declaration.** Measured rather than assumed: the 1.7.0 compiler the 0.3.0 client
carries meets `uses graph: NavGraph` and answers `DS0133 a system body holds \`reads\`, \`writes\`,
\`after\` and one \`update\` block, and nothing else` — against the system, not the clause, so the
declaration is dropped and everything referring to it is wrong too. That is the first of the two
cases in `docs/RELEASING.md`, the one that says re-cut now.

- The server understands `uses`, and the grammar highlights it, both derived from the token table
  rather than written twice.
- Nothing in the client changed. **The version moves because what it carries did**, for the third
  time and for the same reason.

### 0.3.0

**The bundled server is a 1.6.0 one, and that is the whole entry.**

The client carries its own copy of the language server, because a marketplace install has no
`packages/driftscript-language` to walk up to. That copy is frozen at the moment the `.vsix` was
packed — so 0.2.0 shipped a server built against 1.4.0, and it does not merely lack the new
features: **it reports valid code as broken.** A file using a module constant, a list and a `break`
came back with `DS0100 expected a declaration but found \`let\``, `DS0135 expected \`query\``, and
then `DS0102` at the end of the file, because the parse never recovered. A whole document red, in an
editor, for code the compiler accepts.

That is the failure this project already refuses in the language server's own design note — a
squiggle that is sometimes wrong is worse than none — arriving through the packaging rather than
through the code.

- Module constants appear in the outline as constants, complete as values and colour as variables
  rather than as types.
- The server understands everything 1.5.0 and 1.6.0 added: `float` signatures and `nearest`,
  `List<T>` with its literal, index and walk, `break` and `continue`, module constants, component
  rows as parameters, and a component reached through a handle.
- Nothing in the client changed. **The version moves because what it carries did**, which is the
  cost of bundling a server and the reason this line exists separately from the language's.

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
