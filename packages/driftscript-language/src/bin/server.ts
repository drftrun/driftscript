#!/usr/bin/env node
/**
 * The process an editor starts: `node packages/driftscript-language/src/bin/server.ts`.
 *
 * **It takes its host from an argument rather than importing one**, and that is the boundary rather
 * than a convenience. `scripts/boundaries.test.mjs` refuses any `@driftengine/*` import in this
 * package, because the language must be movable without the engine — so the server cannot know what
 * capabilities exist, and a consumer tells it.
 *
 * ```sh
 * node src/bin/server.ts --host ../../script/src/host.ts
 * ```
 *
 * The module named by `--host` may export `registry`, `manifest`, or both. **Anything it does not
 * export is absent rather than defaulted**, and the coverage line the server logs at startup says
 * which — a server that quietly ran with no registry would offer an empty completion list and look
 * broken, which is tooling design §11's whole point.
 *
 * With no `--host` at all the server still runs and still reports every syntax and type error it
 * can find. That is the first-look path, and it is the same shape as the compiler's own optional
 * `registry`: what is missing is missing out loud.
 */
import { readFileSync } from 'node:fs';
import { startServer } from '../server.ts';
import { defineTarget, registryFromJson } from 'driftscript';
import type { CapabilityRegistry, TargetManifest } from 'driftscript';

interface HostModule {
  readonly registry?: CapabilityRegistry;
  readonly manifest?: TargetManifest;
}

function hostPath(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--host');
  return index >= 0 ? argv[index + 1] : undefined;
}

const specifier = hostPath(process.argv);

/*
 * A host that fails to load is reported and then ignored, rather than taking the server down.
 *
 * An editor whose language server exits on startup shows nothing at all — no diagnostics, no
 * highlighting beyond the grammar — and the reason is in a log nobody opens. Running without the
 * host is strictly more useful than not running, and the coverage line then says the registry is
 * absent, which is the truth and is actionable.
 */
let host: HostModule = {};
if (specifier !== undefined) {
  try {
    /*
     * A `.json` host is data; anything else is a module.
     *
     * **The data path is the one that works for most hosts, and not by preference.** A host whose
     * packages use extensionless relative imports — which a bundler resolves and Node does not —
     * cannot be imported by a plain Node process at all, and a language server is a plain Node
     * process. `serializeRegistry` writes what the host provides as data, which R2 makes possible:
     * the registry describes and never invokes, so nothing in it is a function and all of it
     * survives the boundary.
     *
     * The module path stays for a host that *can* be imported — a pure-JavaScript one, or a future
     * package that ships resolvable files. It is the general contract; the JSON is the one this
     * repository uses.
     */
    if (specifier.endsWith('.json')) {
      const data = JSON.parse(readFileSync(specifier, 'utf8')) as {
        manifest?: { name: string; provides: readonly string[] };
      };
      host = {
        registry: registryFromJson(data as never),
        manifest:
          data.manifest === undefined
            ? undefined
            : defineTarget(data.manifest.name, data.manifest.provides),
      };
    } else {
      host = (await import(specifier)) as HostModule;
    }
  } catch (error) {
    process.stderr.write(
      `driftscript-language: could not load host \`${specifier}\`: ${(error as Error).message}\n` +
        'Continuing without a registry: diagnostics will work, completion and hover will not.\n',
    );
  }
}

/*
 * A host that loaded but exports neither name is reported too.
 *
 * That is the likelier mistake than a module that fails to load: somebody points `--host` at a file
 * that plainly describes the engine, it imports cleanly, and it happens to export its registry
 * under another name or behind a function. The server would then run with no registry and look
 * merely opinionless, which is the silent no-op this whole seam is built to avoid.
 */
if (specifier !== undefined && host.registry === undefined && host.manifest === undefined) {
  process.stderr.write(
    `driftscript-language: host \`${specifier}\` exports neither \`registry\` nor \`manifest\`.\n` +
      'Diagnostics will work; completion and hover will offer nothing.\n',
  );
}

startServer({ registry: host.registry, manifest: host.manifest });
