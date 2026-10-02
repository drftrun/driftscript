/**
 * An enum the host declares: a capability answers with a variant, and a script names, compares and
 * matches it as it would one of its own.
 *
 * Before this a capability whose answer was one of a few things could only return a number and a
 * doc sentence saying what each number meant, and every script restated the sentence as constants.
 */
import { describe, expect, it } from 'vitest';
import { compileDriftScript, singleFileHost } from '../index.ts';
import { createRegistry, defineCapability } from '../../registry/capability.ts';
import { registryFromJson, serializeRegistry } from '../../registry/serialize.ts';
import { defineTarget } from '../../registry/manifest.ts';
import { bindHost, loadModule } from '../../runtime/module.ts';
import { patchModule } from '../../runtime/hot.ts';

function contactRegistry() {
  const registry = createRegistry();
  registry.addType({
    module: 'drift/test',
    name: 'Contact',
    doc: 'Whether a touch began, held or ended.',
    variants: ['Began', 'Held', 'Ended'],
  });
  registry.add(
    defineCapability({
      module: 'drift/test',
      name: 'contact',
      signature: 'fn(index: i32) -> Contact',
      params: [{ name: 'index', type: 'i32' }],
      returns: 'Contact',
      effects: ['physics.read'],
      deterministic: true,
      doc: 'How a contact stands.',
      implementation: 'drift/test.contact',
    }),
  );
  return registry;
}

const SOURCE = `import { contact } from "drift/test"

data Tally {
    last: Contact = Contact.Ended
    began: u32 = 0
}

fn count(tally: mut Tally, index: i32) {
    let now = test.contact(index)
    if now == Contact.Began {
        tally.began = tally.began + 1
    }
    tally.last = now
}

fn describe(contact: Contact) -> String {
    return match contact {
        Began => "began"
        Held => "held"
        Ended => "ended"
    }
}
`;

const compile = (source: string, registry = contactRegistry()) =>
  compileDriftScript(source, {
    filename: 'tally.drs',
    manifest: defineTarget('test', ['drift/test']),
    registry,
    host: singleFileHost(),
    mode: 'development',
  });

const importGenerated = (code: string) =>
  import(/* @vite-ignore */ `data:text/javascript;base64,${btoa(code)}`);

describe('an enum the host declares', () => {
  it('is named, compared and matched by a script, with a variant the host answered', async () => {
    const result = compile(SOURCE);
    expect(result.diagnostics).toEqual([]);
    const module = loadModule(await importGenerated(result.code));
    const answers = ['Began', 'Held', 'Began'];
    bindHost(module, { 'drift/test': { contact: (index: number) => ({ tag: answers[index] }) } });
    const exports = module.exports as {
      createTally(): { last: { tag: string }; began: number };
      count(tally: unknown, index: number): void;
      describe(contact: { tag: string }): string;
    };
    const tally = exports.createTally();
    expect(tally.last).toEqual({ tag: 'Ended' });
    for (const index of [0, 1, 2]) exports.count(tally, index);
    expect(tally.began).toBe(2);
    expect(exports.describe(tally.last)).toBe('began');
  });

  it('keeps its variants equal across a hot reload', async () => {
    const result = compile(SOURCE);
    const module = loadModule(await importGenerated(result.code));
    bindHost(module, { 'drift/test': { contact: () => ({ tag: 'Began' }) } });
    const tally = (module.exports.createTally as () => { began: number })();
    patchModule(module, await importGenerated(`${result.code}\n// saved`), { Tally: [tally] });
    (module.exports.count as (t: unknown, i: number) => void)(tally, 0);
    expect(tally.began).toBe(1);
  });

  it('refuses a match that misses a variant, naming it', () => {
    const result = compile(`fn go(contact: Contact) -> bool {
    return match contact {
        Began => true
        Held => true
    }
}
`);
    expect(result.diagnostics.map((d) => d.message).join('\n')).toContain('Ended');
  });

  it('refuses a variant the host did not declare', () => {
    const result = compile('fn go() -> Contact {\n    return Contact.Gone\n}\n');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.code).toBe('');
  });

  it('gives way to a script enum of the same name, since the names in front of you win', async () => {
    const result = compile(`enum Contact {
    Near
    Far
}

fn go() -> Contact {
    return Contact.Far
}
`);
    expect(result.diagnostics).toEqual([]);
    const mod = await importGenerated(result.code);
    expect(mod.go()).toEqual({ tag: 'Far' });
  });

  it('crosses the capability file with its variants', () => {
    const read = registryFromJson(
      JSON.parse(JSON.stringify(serializeRegistry(contactRegistry()))) as never,
    );
    expect(read.getType('Contact')?.variants).toEqual(['Began', 'Held', 'Ended']);
  });

  it('is refused at registration with no variants, a repeated one, or one a script cannot spell', () => {
    const add = (variants: string[]) =>
      createRegistry().addType({ module: 'drift/test', name: 'Bad', doc: 'Bad.', variants });
    expect(() => add([])).toThrow(/no variants/);
    expect(() => add(['On', 'On'])).toThrow(/twice/);
    expect(() => add(['on'])).toThrow(/capital/);
  });
});
