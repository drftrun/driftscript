# DriftScript for VSCode

The editor client. It contains no language logic: every squiggle, completion, hover and colour is
computed by `driftscript-language`, which computes none of them either and calls the compiler.

```
ext install DriftTech.driftscript-vscode
```

Or search **DriftScript** in the Extensions view. It bundles its own language server, so nothing
else has to be installed for it to work.

**If you are not using VSCode, none of this applies to you.** `driftscript-language` speaks stdio
and works with any LSP client.

---

## Working on it

Installing from the marketplace is the way to use it. The rest of this section is for changing it.

```sh
npm run extension      # bundles the client and the server, copies the generated grammar
```

Nothing it writes is committed: the grammar would be a second definition of the language, and the
bundles a second copy of the client and the server.

### Against a real install — build a `.vsix`

```sh
npm run vsix
code --install-extension editors/vscode/driftscript-vscode-*.vsix
```

Worth preferring over the symlink below when checking a change: it exercises the bundled server
instead of the checkout source, so a problem that only shows up in a real install shows up here too.

### Against the checkout — symlink it into your extensions folder

```sh
ln -sfn "$PWD" ~/.vscode/extensions/driftscript-vscode
```

Restart VSCode. Open any `.drs` file. The server it starts is then the **source**, so an edit to it
needs a window reload and no rebuild.

**Symlink it, do not copy it, and the difference is not cosmetic.** The client finds the language
server by walking up from its own file, and Node resolves a symlink to its real path before
computing `__dirname` — so through a symlink it lands in this repository, which is where the server
is. Through a copy it lands in `~/.vscode`, finds nothing, and falls back to the bundled server,
which is not the one you are editing.

To remove it: `rm ~/.vscode/extensions/driftscript-vscode`.

### Against a debugger — the Extension Development Host

Open this repository in VSCode and press <kbd>F5</kbd>. `.vscode/launch.json` builds the client and
opens a second window with it loaded. Reload that window after an edit. Uninstall the marketplace
copy first, or two clients compete for the same `.drs` files.

---

## Settings

| Setting | What it does |
|---|---|
| `driftscript.host` | A `capabilities.json` describing what your host provides, or a module exporting `registry` and/or `manifest`. **There is no default.** |
| `driftscript.server.path` | Where the server is, when it is not where this client would look. |
| `driftscript.trace.server` | `off`, `messages` or `verbose`. The traffic, in an output channel. |

**`driftscript.host` has no default, and that is the honest state, not a gap.** DriftScript
is a language; a host is something your project brings. This repository ships none, so a default
here would be a path to a file that cannot exist, and the warning it produced would read as a broken
extension instead of an unconfigured one.

**It is data, not a module, and not by preference.** An extension host is a plain Node
process, and a host whose own packages use extensionless relative imports cannot be imported by one
at all. A registry describes and never invokes, so nothing in a definition is a function and all of
it survives the boundary. `serializeRegistry` from `driftscript` writes the file.

Without any host the server still reports every syntax and type error, because those need none. What
it cannot do is complete a capability call, hover it with its effects, or grey it where the target
does not provide it. It says which state it is in on startup, in its output channel:

```text
DriftScript · 3 modules · manifest: my-game · registry: 54 capabilities
```

That line is deliberate. A tool that cannot see something has to say so, instead of offering a
completion list that is honest about nothing.

**The server it starts depends on how you loaded it, and the order is deliberate.** The setting
wins;
then the checkout **source**, so an edit to the server is picked up by reloading the window; then
`out/server.mjs`, the bundle, which is all an installed extension has. In a checkout the first two
both exist and the source is the one somebody working on the server wants.

**If you point `driftscript.server.path` at an npm-installed copy, name its built entry** —
`node_modules/driftscript-language/dist/bin/server.js`, not its source. Node will not strip
types for anything under `node_modules`, and that refusal is the one thing in this project a person
can still walk into by hand.

---

## What you should see

- **Highlighting** from the generated TextMate grammar, which is derived from the compiler's own
  token table and is checked for staleness by `npm run grammar:check`.
- **Diagnostics** identical to a build's — same code, same span, same words. That is asserted, not
  intended: `packages/driftscript-language/src/agreement.test.ts` compiles a corpus both ways and
  compares.
- **Semantic tokens** carrying what a signature does not show: which calls touch the world, which
  functions are `@deterministic`, and which capabilities the target cannot link.
- **A `.drs` file icon**: the caret under a diagnostic, which is the language's own mark and the one
  script.driftengine.dev uses. Whether it appears at all depends on your file icon theme, since a
  theme has to defer to language icons instead of mapping the extension itself, and the default Seti
  theme generally does not.

## Licence

MIT. See [`LICENSE`](LICENSE).
