# Contributing

**Patches are welcome and there is a bar.** It is written down here rather than discovered in
review, because a bar somebody meets on the second attempt cost them the first one for nothing.

---

## Getting it running

```sh
git clone https://github.com/drftrun/driftscript.git
cd driftscript
npm ci
npm run build          # emits packages/*/dist, which the size gate measures
npm run extension      # bundles the VSCode client and its server, which the editors gate packs
npm test               # the language
npm run test:scripts   # the gates
npm run typecheck
npm run demo           # a page where a .drs file hot-reloads with its state intact
```

Node 22.12 or newer. There is no other toolchain.

## The shape of a change

**A comment explains why, not what.** The code says what it does. What it cannot say is what was
tried first, what the alternative cost, and what would make this the wrong answer later — and that
is the part a reader six months out actually needs. Most files here open with a paragraph of it.
Match that.

**A claim that can drift is asserted somewhere that fails.** Not written in a document, not left to
review. The tests in `scripts/` are almost all of this shape: the language imports nothing foreign,
the versions agree, the grammar matches the token table, the compiler does not reach a browser
bundle. If your change makes a new claim, it needs a new one of these.

**A diagnostic code is never renumbered.** `DS0205` means what it meant in the version somebody is
running. Add a new code; do not reuse or shuffle.

**A behaviour change comes with the test that fails without it.** A refactor comes with no new tests
and no changed ones — that is what makes it a refactor.

## What gets refused, and why in advance

- **A parser, checker or linker in `driftscript-language`.** It calls the compiler and re-implements
  no part of it. `agreement.test.ts` compiles a corpus both ways and asserts the diagnostics are
  deep-equal. A server with its own front end disagrees with the build eventually, and the day it
  does, people learn to distrust the squiggles — correctly.
- **Any import of an engine, in either package.** DriftScript is a language and DriftEngine is its
  first host. Three separate mechanisms fail when that seam is crossed, and type-only imports count:
  a type is a dependency on a name, and a name that lives elsewhere does not travel.
- **A runtime dependency.** `npm ls driftscript` shows one package. That is a checkable claim on a
  public page and it stays true.
- **A compiler feature reachable from the runtime barrel.** The two entry points are separate so a
  bundler can drop the compiler, and the size gate proves it did.
- **A default that hides a missing thing.** The linker refuses an unprovided module in words. The
  language server says on startup that it has no registry. Completion greys an unavailable
  capability instead of hiding it. A tool that cannot see something says so.

None of these is unarguable. Arguing is fine; quietly working around one is not, because the point
of each is that something fails when it is crossed.

## Where things live

```text
packages/driftscript/            the language: lexer, parser, checkers, IR, emitter, runtime, registry
packages/driftscript-language/   the language server. Calls the compiler, owns nothing it computes
editors/vscode/                  the VSCode client. Contains no language logic at all
scripts/                         the gates. Each one holds a claim that would otherwise drift
docs/corpus/                     .drs files written to be read: what a language designer imagines people write
demo/                            a page where a .drs file hot-reloads with its state intact
```

Tests sit beside the module they cover, as `*.test.ts`.

## Before you open a pull request

```sh
npm run build && npm run extension && npm test && npm run test:scripts && npm run typecheck
```

CI runs the same five. `npm run publish:check` is a release gate rather than a contribution one — it
needs the network and a clean room, and it is not your job to run it.

## Reporting a bug

An [issue](https://github.com/drftrun/driftscript/issues), with the `.drs` that reproduces it. A
compiler bug is almost always a file, and a file is worth more than a description of one.

For anything exploitable, `SECURITY.md` instead.

## Licence

MIT. A contribution is offered under the same terms.
