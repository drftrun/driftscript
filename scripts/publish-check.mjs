/**
 * The gate, run against a tarball in a clean room rather than against this workspace.
 *
 * **Checking the workspace copy is what hid the defect this script exists for**, so a check that
 * reproduced the original mistake would be worse than no check at all. The defect, in full:
 *
 * `driftscript` is written in erasable TypeScript whose relative imports name `.ts`, so that Node
 * can type-strip the Vite plugin and the compiler it pulls in. **Node refuses to strip types for
 * any file under `node_modules`** — `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, a categorical
 * refusal rather than a resolution failure. Inside a workspace the package resolves through a
 * symlink whose real path has no `node_modules` segment in it, so the refusal never fires. From a
 * tarball it is a real directory inside `node_modules`, and it fires on the first import.
 *
 * The result was that five of seven consumer paths were broken while all 839 tests passed, and no
 * test in the suite could have seen it, because every one of them runs inside the workspace where
 * the symlink hides the cause. `npm run build` is the fix; this is what proves the fix is still in
 * place.
 *
 * **This needs the network**, because a clean-room install resolves the language server's own
 * dependencies from the registry. It is therefore not part of `npm test`: it is run before a
 * release, by `npm run publish:check`, and by the release workflow. `--prefer-offline` lets a warm
 * npm cache carry it when there is no connection.
 *
 * Rows 10 to 12 of the gate are asserted by the ordinary suite instead, because they need no clean
 * room: `scripts/publish.test.mjs` holds the metadata and the README links, and
 * `scripts/size-gate.test.mjs` holds the runtime/compiler separation.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGES = ['driftscript', 'driftscript-language'];

const rows = [];
let room;

function record(name, run) {
  try {
    const detail = run();
    rows.push({ name, ok: true, detail: detail ?? '' });
  } catch (error) {
    rows.push({ name, ok: false, detail: String(error.message ?? error).split('\n').slice(0, 6).join('\n      ') });
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options });
}

/* ------------------------------------------------------------------ the room */

process.stdout.write('building…\n');
run('node', [path.join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT, stdio: 'inherit' });

process.stdout.write('packing…\n');
room = mkdtempSync(path.join(tmpdir(), 'driftscript-publish-'));
const tarballs = {};
for (const name of PACKAGES) {
  const output = run('npm', ['pack', '--pack-destination', room, '-w', name], { cwd: ROOT });
  const file = output.trim().split('\n').pop().trim();
  tarballs[name] = path.join(room, file);
}

/* ------------------------------------------------ rows 7 and 8: the tarball itself */

for (const name of PACKAGES) {
  const listing = run('tar', ['-tzf', tarballs[name]])
    .split('\n')
    .map((line) => line.replace(/^package\//, ''))
    .filter(Boolean);

  record(`${name}: no tests in the tarball`, () => {
    const tests = listing.filter((file) => file.includes('.test.'));
    if (tests.length > 0) {
      throw new Error(`${tests.length} test files ship: ${tests.slice(0, 3).join(', ')}…`);
    }
    return `${listing.length} files`;
  });

  record(`${name}: the licence travels with the copy`, () => {
    if (!listing.includes('LICENSE')) {
      throw new Error('no LICENSE in the tarball. MIT requires the notice to travel; a field is not the notice');
    }
    return 'LICENSE';
  });
}

/* ------------------------------------------------------- row 1: clean-room install */

const app = path.join(room, 'app');
mkdirSync(app, { recursive: true });
writeFileSync(
  path.join(app, 'package.json'),
  JSON.stringify({ name: 'clean-room', version: '0.0.0', private: true, type: 'module' }, null, 2),
);

record('a clean-room install succeeds', () => {
  run('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund', tarballs.driftscript, tarballs['driftscript-language']], {
    cwd: app,
  });
  const real = path.join(app, 'node_modules', 'driftscript', 'package.json');
  if (!existsSync(real)) throw new Error('driftscript is not in node_modules after install');
  return 'both packages installed as real directories';
});

/*
 * The two fixtures a consumer actually writes.
 *
 * `.drs` first, because everything below either compiles it or refuses to. It uses `std/math`
 * alone, so it links against a target that provides nothing — which is the property that makes
 * this a language rather than an engine's scripting layer, and it is checked here from the outside.
 */
writeFileSync(
  path.join(app, 'door.drs'),
  [
    'import { clamp } from "std/math"',
    '',
    'data DoorState {',
    '    openness: f32 = 0',
    '}',
    '',
    'fn nudge(state: DoorState, by: f32) -> f32 {',
    '    return math.clamp(state.openness + by, 0, 1)',
    '}',
    '',
  ].join('\n'),
);

writeFileSync(
  path.join(app, 'main.ts'),
  [
    "import { loadModule, setClockSource, tickTasks } from 'driftscript';",
    "import * as door from './door.drs';",
    '',
    'setClockSource({ fixedSteps: () => 0, fixedStep: () => 1 / 60, frame: () => 0, wall: () => 0 });',
    'const loaded = loadModule(door as unknown as Record<string, unknown>);',
    'tickTasks();',
    'export const nudge = loaded.exports.nudge;',
    '',
  ].join('\n'),
);

/*
 * The bundler config, and it does something that used to be impossible.
 *
 * **It imports `driftscript` from inside a `vite.config.ts`.** A bundler config is loaded by Node
 * before any bundler exists, and for as long as this package shipped TypeScript source that import
 * failed outright from an install — so the checked configuration, the one that infers effects and
 * refuses an unprovided module, was unreachable for every real consumer. A build with no registry
 * infers nothing and refuses nothing, which means `@deterministic` was decoration.
 *
 * So the gate configures the checked path rather than the first-look one. Anything less would pass
 * against a package that had quietly regressed to the shape this repository exists to correct.
 */
writeFileSync(
  path.join(app, 'vite.config.ts'),
  [
    "import { createRegistry, defineTarget } from 'driftscript';",
    "import { registerStd } from 'driftscript/std';",
    "import { driftScript } from 'driftscript/vite';",
    '',
    'const registry = createRegistry();',
    'registerStd(registry);',
    '',
    'export default {',
    "  plugins: [driftScript({ registry, manifest: defineTarget('clean-room', []) })],",
    "  build: { lib: { entry: 'main.ts', formats: ['es'], fileName: 'out' }, minify: false },",
    '};',
    '',
  ].join('\n'),
);

/*
 * Row 9's tsconfig: strict, and with **no** `allowImportingTsExtensions`.
 *
 * That flag used to be non-optional for anybody who consumed this package, because `tsc` followed
 * the import into it and reported TS5097 on every relative import in its source. A published
 * package asking a stranger to set a compiler flag before it will typecheck is a smell, and the
 * build is what removed it. `skipLibCheck: false` is what makes the row mean something: it asks
 * whether the shipped declarations typecheck inside somebody else's project.
 */
writeFileSync(
  path.join(app, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        lib: ['ES2022', 'DOM'],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
      },
      include: ['main.ts', 'reference.d.ts'],
    },
    null,
    2,
  ),
);

/* One line replaces the block of `declare module` this README used to ask a reader to copy. */
writeFileSync(path.join(app, 'reference.d.ts'), '/// <reference types="driftscript/drs" />\n');

/* ----------------------------------------- rows 3 to 5: the build side, from an install */

record('a Vite config imports the package, and its .drs reaches the bundle', () => {
  run(path.join(ROOT, 'node_modules', '.bin', 'vite'), ['build'], { cwd: app });
  const bundle = readFileSync(path.join(app, 'dist', 'out.js'), 'utf8');
  if (!bundle.includes('nudge')) throw new Error('the compiled .drs module is not in the output bundle');
  if (!bundle.includes('__drift')) throw new Error('the output has no module descriptor, so nothing was transformed');
  return 'plugin loaded, .drs transformed, module in the bundle';
});

record('the compiler loads in a plain Node process', () => {
  run('node', ['-e', "import('driftscript/compiler').then((m) => { if (typeof m.compileDriftScript !== 'function') throw new Error('no compileDriftScript'); })"], {
    cwd: app,
  });
  return 'driftscript/compiler resolves and exports compileDriftScript';
});

record('the runtime loads in a plain Node process', () => {
  run('node', ['-e', "import('driftscript').then((m) => { if (typeof m.loadModule !== 'function') throw new Error('no loadModule'); })"], {
    cwd: app,
  });
  return 'driftscript resolves and exports loadModule';
});

/* --------------------------------------------------------- row 9: the typecheck */

record('a consumer typechecks with no compiler flag of ours', () => {
  run(path.join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', path.join(app, 'tsconfig.json')], { cwd: app });
  return 'tsc --noEmit passes with skipLibCheck: false and no allowImportingTsExtensions';
});

/* ------------------------------------------------ row 6: the language server starts */

record('the language server binary spawns and answers an LSP initialize', async () => null);
rows.pop();

const initialize = await (async () => {
  const bin = path.join(app, 'node_modules', 'driftscript-language', 'dist', 'bin', 'server.js');
  if (!existsSync(bin)) return { ok: false, detail: `no bin at ${path.relative(app, bin)}` };

  const child = spawn('node', [bin], { cwd: app, stdio: ['pipe', 'pipe', 'pipe'] });
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { processId: process.pid, rootUri: null, capabilities: {} },
  });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);

  const answer = await new Promise((resolve) => {
    let out = '';
    let stderr = '';
    const done = setTimeout(() => resolve({ ok: false, detail: `no reply in 15s. stderr: ${stderr.slice(0, 200)}` }), 15_000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('"capabilities"')) {
        clearTimeout(done);
        resolve({ ok: true, detail: 'answered initialize with a capability set' });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(done);
      resolve({ ok: false, detail: error.message });
    });
    child.on('exit', (code) => {
      clearTimeout(done);
      resolve({ ok: false, detail: `exited with ${code}. stderr: ${stderr.slice(0, 300)}` });
    });
  });
  child.kill();
  return answer;
})();

rows.push({ name: 'the language server spawns and answers an LSP initialize', ...initialize });

/* ------------------------------------------------------------------- the report */

const red = rows.filter((row) => !row.ok);
process.stdout.write('\n');
for (const row of rows) {
  process.stdout.write(`  ${row.ok ? 'ok  ' : 'FAIL'}  ${row.name}\n`);
  if (row.detail) process.stdout.write(`        ${row.detail}\n`);
}
process.stdout.write(`\n${rows.length - red.length}/${rows.length} green\n`);

if (process.env.DRIFTSCRIPT_KEEP_ROOM === '1') {
  process.stdout.write(`clean room kept at ${room}\n`);
} else {
  rmSync(room, { recursive: true, force: true });
}

if (red.length > 0) {
  process.stdout.write('\nnothing is published while a row is red.\n');
  process.exitCode = 1;
}
