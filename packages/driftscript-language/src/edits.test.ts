import { describe, expect, it } from 'vitest';
import { createRegistry, defineCapability, defineTarget } from 'driftscript';
import { applyEdits } from './edits.ts';
import { createService } from './service.ts';

/**
 * The features that change a file, tested by the refusals as much as by the edits.
 *
 * A rename that silently does the wrong thing is worse than one that declines: the wrong thing gets
 * applied across a file and reviewed as a mechanical change. So every refusal here is asserted for
 * its *reason*, not only for having refused.
 */
const registry = () => {
  const r = createRegistry();
  for (const name of ['play', 'stop']) {
    r.add(
      defineCapability({
        module: 'drift/audio',
        name,
        signature: 'fn(slot: String) -> void',
        params: [{ name: 'slot', type: 'String' }],
        returns: 'void',
        effects: ['audio.write'],
        deterministic: false,
        doc: `${name} a sound.`,
        implementation: `AudioGraph.${name}`,
      }),
    );
  }
  return r;
};

const SOURCE = `import { play, stop } from "drift/audio"

data Door {
    open: bool = false
}

fn shut(door: mut Door) {
    door.open = false
}

fn ring(door: Door) {
    audio.play("bell")
}
`;

const at = (needle: string, occurrence = 1, text = SOURCE) => {
  let index = -1;
  for (let i = 0; i < occurrence; i += 1) index = text.indexOf(needle, index + 1);
  return index;
};

const serviceWith = (text = SOURCE, manifest?: ReturnType<typeof defineTarget>) => {
  const service = createService({ registry: registry(), manifest });
  service.open('a.drs', text);
  return service;
};

describe('references', () => {
  it('finds every use of a declaration in the file', () => {
    const spans = serviceWith().references('a.drs', at('Door'));
    /* `data Door`, `door: mut Door`, `door: Door` — three. */
    expect(spans).toHaveLength(3);
    for (const span of spans) expect(SOURCE.slice(span.start, span.end)).toBe('Door');
  });

  it('finds a field by name, because that is the same name to a reader', () => {
    const spans = serviceWith().references('a.drs', at('open'));
    expect(spans.length).toBeGreaterThanOrEqual(2);
  });

  it('answers nothing over a place with no name', () => {
    expect(serviceWith().references('a.drs', at('"bell"'))).toEqual([]);
  });
});

describe('rename', () => {
  it('renames a declaration and every use of it', () => {
    const result = serviceWith().rename('a.drs', at('Door'), 'Gate');
    expect(result.renamed).toBe(true);
    if (!result.renamed) throw new Error('expected a rename');

    const next = applyEdits(SOURCE, result.edits);
    expect(next).toContain('data Gate');
    expect(next).toContain('door: mut Gate');
    expect(next).not.toContain('Door');
    /* The variable `door` is a different name and must survive untouched. */
    expect(next).toContain('door.open');
  });

  it('refuses a capability, naming where its definition actually lives', () => {
    const result = serviceWith().rename('a.drs', at('play', 2), 'sound');
    expect(result.renamed).toBe(false);
    if (result.renamed) throw new Error('expected a refusal');
    expect(result.reason).toContain('drift/audio');
    expect(result.reason).toContain('not by this file');
    expect(result.reason).toContain('rename nothing');
  });

  it('refuses a namespace, because its name follows the module', () => {
    const result = serviceWith().rename('a.drs', at('audio.play'), 'sfx');
    expect(result.renamed).toBe(false);
    if (result.renamed) throw new Error('expected a refusal');
    expect(result.reason).toContain('Change the import');
  });

  it('refuses part of the language', () => {
    const result = serviceWith().rename('a.drs', at('bool'), 'boolean');
    expect(result.renamed).toBe(false);
    if (result.renamed) throw new Error('expected a refusal');
    expect(result.reason).toContain('part of the language');
  });

  it('refuses a name that is already declared', () => {
    const result = serviceWith().rename('a.drs', at('shut'), 'ring');
    expect(result.renamed).toBe(false);
    if (result.renamed) throw new Error('expected a refusal');
    expect(result.reason).toContain('already declared');
  });

  it('refuses a name that is not a name', () => {
    const result = serviceWith().rename('a.drs', at('Door'), '2things');
    expect(result.renamed).toBe(false);
  });

  it('produces edits that leave the file still compiling', () => {
    const result = serviceWith().rename('a.drs', at('shut'), 'close');
    if (!result.renamed) throw new Error('expected a rename');

    const next = applyEdits(SOURCE, result.edits);
    const after = createService({ registry: registry() });
    after.open('b.drs', next);
    expect(after.rawDiagnostics('b.drs').filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('code actions', () => {
  it('offers to add an unprovided module to the target manifest, as an instruction', () => {
    /* A target manifest lives in a consumer's build configuration, in TypeScript, in a file this
       server has never been shown. An action that silently did nothing would be worse than none. */
    const service = serviceWith(SOURCE, defineTarget('web-min', []));
    /* Found by code rather than taken by index: a file with more than one diagnostic offers more
       than one action, and asserting on `[0]` is asserting on an order nothing guarantees. */
    const action = service.codeActions('a.drs').find((a) => a.diagnostic === 'DS0301');
    expect(action).toBeDefined();
    expect(action?.title).toContain('drift/audio');
    expect(action?.edits).toEqual([]);
    expect(action?.manual).toContain('web-min');
    expect(action?.manual).toContain('build configuration');
  });

  it('offers to remove an unused import, and the edit leaves valid syntax', () => {
    const service = serviceWith(SOURCE, defineTarget('full', ['drift/audio']));
    const action = service.codeActions('a.drs').find((a) => a.diagnostic === 'DS0290');
    expect(action?.title).toContain('stop');

    const next = applyEdits(SOURCE, action?.edits ?? []);
    expect(next).toContain('import { play } from "drift/audio"');

    const after = createService({ registry: registry(), manifest: defineTarget('full', ['drift/audio']) });
    after.open('b.drs', next);
    expect(after.rawDiagnostics('b.drs')).toEqual([]);
  });

  it('removes a leading name without leaving a stray comma', () => {
    const text =
      'import { stop, play } from "drift/audio"\n\nfn ring() {\n    audio.play("bell")\n}\n';
    const service = serviceWith(text, defineTarget('full', ['drift/audio']));
    const action = service.codeActions('a.drs').find((a) => a.diagnostic === 'DS0290');
    const next = applyEdits(text, action?.edits ?? []);
    /* `import { , play }` is a syntax error introduced by a fix — the worst thing an action can do. */
    expect(next).not.toContain('{ ,');
    expect(next).toContain('import { play }');
  });

  it('does not offer to remove the only name in an import list', () => {
    /* Removing it leaves `import { } from …`, which parses and says nothing — so the action is
       withheld rather than offering a change that needs a second one. */
    const text = 'import { stop } from "drift/audio"\n\nfn ring() {\n}\n';
    const service = serviceWith(text, defineTarget('full', ['drift/audio']));
    expect(service.codeActions('a.drs').filter((a) => a.diagnostic === 'DS0290')).toEqual([]);
  });

  it('offers to add a member the file called but did not import', () => {
    const text =
      'import { play } from "drift/audio"\n\nfn hush() {\n    audio.stop("bell")\n}\n\nfn ring() {\n    audio.play("bell")\n}\n';
    const service = serviceWith(text, defineTarget('full', ['drift/audio']));
    const action = service.codeActions('a.drs').find((a) => a.diagnostic === 'DS0235');
    expect(action?.title).toContain('stop');

    const next = applyEdits(text, action?.edits ?? []);
    const after = createService({ registry: registry(), manifest: defineTarget('full', ['drift/audio']) });
    after.open('b.drs', next);
    expect(after.rawDiagnostics('b.drs')).toEqual([]);
  });
});
