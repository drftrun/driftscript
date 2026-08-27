# driftscript-language

The [DriftScript](https://script.driftengine.dev) language server: **it calls the compiler and
re-implements no part of it.**

```sh
npm i -D driftscript-language
```

It installs `driftscript` with it, pinned to the exact version, and puts a `driftscript-language`
binary on your path.

## The one decision everything else rests on

There is no parser, type checker, effect checker or linker in this package. `diagnostics()` is
`compileDriftScript().diagnostics`, exactly, and a test compiles a corpus both ways and asserts they
are deep-equal — same code, same span, same words.

A server with its own front end disagrees with the build eventually: a keyword the lexer learned and
the server did not, a rule the checker tightened. The day it does, people learn to distrust the
squiggles, and they are right to. **A squiggle that is sometimes wrong is worse than none**, because
it costs attention every time.

The exact version pin is the other half of that. A server compiled against a different compiler than
your build runs is precisely the disagreement the agreement test exists to prevent, so a language
release is two publishes in a fixed order, not a caret range.

## What it does own

Position mapping, the document store, caching, incremental scheduling, and the two features that
present compiler facts without computing any: capability-true completion, and semantic tokens
carrying effects and determinism.

**Completion is capability-true.** An unavailable capability is offered and *marked*, never hidden.
Hiding it teaches a script author the surface does not exist; showing it greyed teaches them it
exists and their target does not provide it, which is true, actionable, and what the linker would
tell them thirty seconds later.

## Running it

```sh
npx driftscript-language --host ./capabilities.json
```

Or from an editor client, as a stdio language server.

The host argument is what makes completion and hover useful, and **without it they offer nothing**
while diagnostics still work. The server says which state it is in on startup, so you are never
reading a list that is honest about nothing:

```text
DriftScript · 3 modules · manifest: my-game · registry: 54 capabilities
```

**The host crosses as data, not as a module, and that is not a preference.** A language
server is a plain Node process, and a host whose packages use extensionless relative imports cannot
be imported by one at all. A registry describes and never invokes, so nothing in a definition is a
function and all of it survives the boundary. `serializeRegistry` from `driftscript` writes the
file; `--host` reads it.

A `--host` that names something other than a `.json` is imported as a module, and may export
`registry`, `manifest`, or both. Anything it does not export is absent, never defaulted, and
the startup line says which.

## Editor clients

The VSCode client is on the marketplace as
[`DriftTech.driftscript-vscode`](https://marketplace.visualstudio.com/items?itemName=DriftTech.driftscript-vscode),
and its source is in the same repository at
[`editors/vscode`](https://github.com/drftrun/driftscript/tree/main/editors/vscode). It bundles this
package, so installing it needs nothing else.

Any LSP client works. The server speaks stdio and needs no extension-specific handshake.

## Version

`driftscript-language` and `driftscript` move together, in that order. See
[the changelog](CHANGELOG.md).

## Licence

MIT. See [`LICENSE`](LICENSE).
