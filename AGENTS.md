# Working in this repository

**DriftScript is a language, and a host is something a project brings.** Every rule below is
downstream of that sentence. If a change makes the language know something about a host, it is
wrong, and something in `scripts/` fails to say so.

This file is the contract for anyone — person or agent — changing code here.
[`CONTRIBUTING.md`](CONTRIBUTING.md) is the shorter version for a first patch, and
[`docs/RELEASING.md`](docs/RELEASING.md) is what a release does.

**Everything else is written beside the code it governs.** A decision that could only be understood
by reading a separate document is one somebody will make again in a comment that contradicts it, so
the reasoning lives in the file — most of them open with a paragraph of it, and several name the
mistake that gave the code its shape.

---

## The seam

`driftscript` depends on nothing. Not an engine, not an engine's types, not for convenience.

**Three mechanisms fail when that is crossed, and they catch different things:**

| Mechanism | What it catches |
|---|---|
| `scripts/boundaries.test.mjs` | the import itself, in the source text, including type-only ones a bundler would erase |
| `scripts/size-gate.test.mjs` | the consequence — foreign code actually reaching a bundle |
| `scripts/version.test.mjs` | the language drifting onto somebody else's release cadence |

Neither of the first two subsumes the other. A dead import tree-shakes away and the size gate passes;
the boundary test refuses it anyway, on the grounds that a package which *names* something it cannot
reach is not movable.

**A shared type is restated at the boundary rather than imported.** A type is a dependency on a
name, and a name that lives in another repository does not travel. That cost is deliberate.

## Two constraints that apply to this package and would be wrong anywhere else

`driftscript` ships a Vite plugin, and **a bundler plugin is loaded by the toolchain, which is
Node** — not by the bundler.

- **Relative imports name the `.ts` file.** Node's ESM resolver requires an extension.
  `allowImportingTsExtensions` is set so this compiles; it only *permits* the extension.
- **No TypeScript syntax that requires code generation.** Node loads `.ts` by *stripping* types, so
  parameter properties, `enum` and `namespace` are all `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.

Both were found by starting a server rather than by reasoning.

**And the third thing, which is the one that cost a repository.** Node refuses to strip types for
any file under `node_modules` — `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, a categorical refusal.
A workspace resolves this package through a symlink whose real path has no `node_modules` segment in
it, so **the refusal never fires locally and always fires from an install.** That is why
`npm run build` exists, why `exports` points at `dist/`, and why `scripts/publish-check.mjs` runs
against a tarball in a clean room instead of against this workspace.

*Checking the workspace copy is what hid it. A check that reproduces the original mistake is worse
than no check.*

## A bundler config is Node, so it cannot import an arbitrary host — hard rule

A `vite.config.ts` is loaded by Node before any bundler exists. A host whose packages use
extensionless relative imports cannot be imported there at all, and the failure is silent in the
direction that matters: a build with no registry infers no effects and refuses no unprovided module,
so **`@deterministic` becomes decoration**.

This shipped once as documentation telling consumers to do the impossible.

**So: anything a consumer's toolchain must reach crosses as data, or lives in a package whose
imports name a `.ts` file.** A registry *describes and never invokes*, so nothing in a definition is
a function and all of it survives a process boundary — which is why `serializeRegistry` and
`registryFromJson` exist and why the language server takes `--host` as a path.

Before adding an option that takes a host object, ask which of the two it is. If the answer is
"they import it in their config", it is neither.

## What the code may not do

These are cited by name in comments throughout the source. They are here so those citations resolve.

**No silent no-ops.** A call that cannot do what it was asked says so. `patchModule` on a disposed
module throws; the linker refuses an unprovided capability in words naming the module and the
target; the language server reports that it has no registry on startup rather than returning an
empty completion list. **A tool that cannot see something has to say it cannot see it** — an empty
answer and an unavailable answer look identical to a caller and mean opposite things.

**No `Date.now()`, no `Math.random()`, no ambient clock.** Time enters through `setClockSource` and
nowhere else. A resume point is a promise about replay, and a task that read the wall clock behind
the scheduler's back breaks it in a way nothing observes until a replay diverges.

**No allocation on a per-frame path.** A task's frame is a reused object; a query loop's cursor comes
from a pool. Allocation is arrived at one `await` at a time, so it is refused at each one.

**Fail fast at init, tolerate at runtime.** A malformed capability definition throws when the
registry is built, in a build process or a test. A missing host at runtime degrades and says so.
Init is where a person is watching.

**Check the artefact, not the source that produced it.** The size gate bundles what a consumer
resolves; `publish-check.mjs` installs a real tarball in a clean room; the editors gate packs a
`.vsix` and sends the server inside it an LSP `initialize`. Every one of those exists because
something built cleanly, typechecked, passed every unit test, and did not work. **A workspace is a
generous place and a stranger's machine is not.**

**Generate rather than hand-write, and the direction is the safety property.** The TextMate grammar
is derived from the compiler's token table, never the reverse. A grammar that has drifted still
highlights — it just highlights the wrong things — so nothing fails and nobody notices until
somebody reads a keyword rendered as a variable and doubts their own file.

**A claim that can drift is asserted somewhere that fails.** Not in a document, not in review. Every
file in `scripts/` is one claim held this way. If a change makes a new claim, it needs a new one.

## The version line

`driftscript` and `driftscript-language` move together, in that order, and nothing else moves them.
The VSCode client carries its own number. `scripts/version.test.mjs` asserts the line, the count of
manifests on it, and the count of internal ranges — **and the counts are the half that matters**,
because a package filed on the wrong line leaves one number right and the other wrong, which a
single check cannot see.

**The ranges are the half that is invisible locally.** Every package here is a workspace link, so a
range left at the previous version resolves to whatever is on disk and stays green through every
command. It fails the first time npm goes to the registry and gets a 404 for a version that has
never been published, and the error names the registry rather than the bump, so it reads as
infrastructure. That is how the first release on this line failed.

`npm install --package-lock-only` writes the lockfile. Run `npm ci` before pushing a release; it is
the one command that reads the lockfile the way a stranger's CI does.

**At most one release per working session**, carrying everything that session finished. A minor
where public surface was added or its behaviour changed; a patch where nothing a consumer can name
is different. A version number is quoted in bug reports and compared across machines.

## The language server owns nothing it computes

`diagnostics()` is `compileDriftScript().diagnostics`, exactly. `agreement.test.ts` compiles a corpus
both ways and asserts they are deep-equal — same code, same span, same words.

A server with its own front end disagrees with the build eventually, and the day it does, people
learn to distrust the squiggles, and they are right to. **A squiggle that is sometimes wrong is
worse than none.**

## A diagnostic code is never renumbered

`DS0205` means what it meant in the version somebody is running. Codes are a published compatibility
surface from 1.4.0 onward. Add; never reuse or shuffle.

## Comments explain why

The code says what it does. What it cannot say is what was tried first, what the alternative cost,
and what would make this the wrong answer later. Most files here open with a paragraph of exactly
that, and several document a mistake by name because the mistake is the reason the code has its
shape.

**Where a comment names a failure, it names a real one.** Nothing in this file or in a source comment
is an illustrative hypothetical.

## Commands

```sh
npm run build          # emits packages/*/dist; the size gate and the publish gate both need it
npm run extension      # bundles the VSCode client and its server; the editors gate needs it
npm test               # the language
npm run test:scripts   # the gates in scripts/
npm run typecheck      # two configs: the language, and the Node-side files
npm run grammar:check  # fails if the generated grammar has drifted from the token table
npm run demo           # a page where a .drs file hot-reloads with its state intact
npm run vsix           # an installable .vsix, which is what a marketplace install would be
npm run publish:check  # the clean room. Needs the network. A release gate, not a commit gate
```
