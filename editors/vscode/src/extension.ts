/**
 * The client. It contains no language logic, and that is the whole contract of this folder.
 *
 * Every answer a person sees — a squiggle, a completion, a hover, a colour — is computed by
 * `driftscript-language`, which computes none of them either and calls the compiler. This file
 * starts that process, tells VSCode which documents to send it, and stops it on the way out.
 *
 * **It is not published**, per the tooling design's §13. The engine is closed, so a marketplace
 * listing would advertise a language nobody outside can run. It is loaded from disk by whoever is
 * working on the engine.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

/**
 * The server inside this repository, found by walking up from this file.
 *
 * Correct when the extension folder is the one in the checkout — loaded in place, or symlinked into
 * `~/.vscode/extensions`, since Node resolves a symlink to its real path before computing
 * `__dirname`. It is the development path, and it points at the **source**, so an edit to the server
 * is picked up by reloading the window rather than by rebuilding anything.
 */
function serverInCheckout(): string {
  return path.join(__dirname, '..', '..', '..', 'packages', 'driftscript-language', 'src', 'bin', 'server.ts');
}

/**
 * The server this extension carries, which is how anybody who did not clone the repository gets one.
 *
 * **Until this existed the extension could not be published at all**, and the reason had nothing to
 * do with whether a listing was wanted. `serverInCheckout` walks three levels up from `out/`, which
 * inside a marketplace install lands in `~/.vscode/` and finds nothing — so the extension would
 * activate, start no server, and leave every `.drs` file looking like a language server with no
 * opinions. That is the worst failure shape this codebase recognises, and it was the honest blocker
 * behind "it is not published".
 *
 * **Bundled beside this file rather than installed as a dependency, and that is a correction.** The
 * first attempt declared `driftscript-language` in `dependencies` and resolved it out of
 * `node_modules`, which reads as the tidier answer and does not survive `vsce`: the workspace
 * resolves that name through a symlink into `packages/`, so packaging followed it out of the
 * extension folder and tried to pack the entire repository. Third appearance of the same
 * workspace-symlink trap, in a third tool. `scripts/build.mjs` emits `out/server.mjs` and there is
 * no symlink anywhere in it.
 *
 * `.mjs` because the server awaits a dynamic import at its top level, which CommonJS has no form
 * for.
 */
function serverBundled(): string {
  return path.join(__dirname, 'server.mjs');
}

/**
 * Where the server lives.
 *
 * The setting wins when it is set. Then the checkout source, then the bundle — **in that order,
 * because in a checkout both exist and the source is the one somebody working on the server wants**,
 * picked up by reloading the window rather than by rebuilding. In an installed extension the source
 * is absent, so it falls through on its own rather than by a flag that could be set wrongly.
 */
function serverEntry(): string {
  const configured = vscode.workspace.getConfiguration('driftscript').get<string>('server.path');
  if (configured !== undefined && configured !== '') return configured;

  const checkout = serverInCheckout();
  if (existsSync(checkout)) return checkout;

  return serverBundled();
}

/**
 * What the host provides, as data — and there is no default, deliberately.
 *
 * **This used to default to the engine's generated `capabilities.json`, and that default came from
 * living in the engine's repository.** DriftScript is a language and a host is something a project
 * brings; this repository ships no host at all, so a default here would be a path to a file that
 * does not exist, and the failure would read as a broken extension rather than as an unconfigured
 * one.
 *
 * With no host, diagnostics still work — every syntax and type error needs none. What is missing is
 * completion, hover and the greying of capabilities a target does not provide, and **the server
 * says which state it is in on its first line of output** rather than presenting a list that is
 * honest about nothing. That line is why nothing is shown here: a modal on every activation would
 * be noise, and a silence with nowhere to read the reason would be the no-op this whole seam avoids.
 *
 * It is data rather than a module, and not by preference: an extension host is a plain Node
 * process, and a registry describes and never invokes — so nothing in a description is a function
 * and all of it survives the boundary.
 */
function capabilitiesPath(): string {
  return vscode.workspace.getConfiguration('driftscript').get<string>('host') ?? '';
}

export function activate(context: vscode.ExtensionContext): void {
  const entry = serverEntry();

  /*
   * A missing server is reported, not ignored.
   *
   * Two ways to get here and the message has to serve both. From a checkout, somebody **copied**
   * the extension folder into `~/.vscode/extensions` instead of symlinking it, so the walk-up lands
   * in `~/.vscode` and the dependency is not installed either. From an install, the dependency is
   * missing, which should not happen and means the package was built without it.
   *
   * Either way the failure is the worst kind if it stays quiet: the extension activates, starts
   * nothing, and every `.drs` file looks like a language server that has no opinions. Naming the
   * setting is the actionable half.
   */
  if (!existsSync(entry)) {
    void vscode.window.showErrorMessage(
      'DriftScript: no language server found. Set `driftscript.server.path`, or — if you are ' +
        'running this from a checkout — symlink the extension folder rather than copying it, ' +
        'since the default path is resolved relative to this file.',
    );
    return;
  }

  /*
   * A host that was configured and is not there is reported. A host that was never configured is
   * not, because that is the ordinary first-run state rather than a mistake — see
   * `capabilitiesPath`.
   */
  const host = capabilitiesPath();
  if (host !== '' && !existsSync(host)) {
    void vscode.window.showWarningMessage(
      `DriftScript: no capability description at ${host}. ` +
        'Check `driftscript.host`, or clear it. ' +
        'Diagnostics will work; completion and hover will offer nothing.',
    );
  }

  /*
   * The server is TypeScript, run by Node's own type stripping.
   *
   * That works because the default entry is a *checkout* path, whose real path has no
   * `node_modules` segment in it. Node refuses to strip types for anything under `node_modules`, so
   * pointing `driftscript.server.path` at an installed copy of `driftscript-language` means naming
   * its built entry — `node_modules/driftscript-language/dist/bin/server.js` — rather than its
   * source. That is the same refusal this package's build exists to get out from under, and it is
   * the one place a person can still walk into it.
   */
  const run = {
    module: entry,
    transport: TransportKind.stdio,
    args: host === '' ? [] : ['--host', host],
  };

  const serverOptions: ServerOptions = { run, debug: run };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'driftscript' }],
    /*
     * The manifest is watched, because §7's greyed completion entries are wrong the moment it
     * changes and nothing else would tell the server that.
     */
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.drs'),
    },
  };

  client = new LanguageClient('driftscript', 'DriftScript', serverOptions, clientOptions);
  void client.start();
  context.subscriptions.push({ dispose: () => void client?.stop() });
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
