import { describe, expect, it } from 'vitest';
import { createRegistry, defineCapability, defineTarget } from 'driftscript';
import { createService } from './service.ts';

/**
 * The editor features, and the property each is for.
 *
 * Every one of these presents a compiler or registry fact. Where a test asserts a *judgement* —
 * whether something links, what effects a call has — it is asserting that the feature asked rather
 * than decided, which is why the expectations are written against the registry and the manifest
 * rather than against hard-coded strings.
 */
const registry = () => {
  const r = createRegistry();
  r.addType({ module: 'drift/scene', name: 'Node', doc: 'A node in the scene graph.' });
  r.add(
    defineCapability({
      module: 'drift/audio',
      name: 'play',
      signature: 'fn(slot: String) -> void',
      params: [{ name: 'slot', type: 'String' }],
      returns: 'void',
      effects: ['audio.write'],
      deterministic: false,
      doc: 'Play a resolved sound slot through the mix.',
      implementation: 'AudioGraph.play',
    }),
  );
  r.add(
    defineCapability({
      module: 'drift/audio',
      name: 'stop',
      signature: 'fn(slot: String) -> void',
      params: [{ name: 'slot', type: 'String' }],
      returns: 'void',
      effects: ['audio.write'],
      deterministic: false,
      doc: 'Stop a sound.',
      implementation: 'AudioGraph.stop',
    }),
  );
  r.add(
    defineCapability({
      module: 'drift/ecs',
      name: 'query',
      signature: 'fn(mask: u32) -> u32',
      params: [{ name: 'mask', type: 'u32' }],
      returns: 'u32',
      effects: ['ecs.read'],
      deterministic: true,
      doc: 'Every entity matching a mask.',
      implementation: 'World.query',
    }),
  );
  return r;
};

const SOURCE = `import { play, stop } from "drift/audio"

data Door {
    open: bool = false
}

@deterministic
fn shut(door: mut Door) {
    door.open = false
}

fn ring() {
    audio.play("bell")
}
`;

/** Where a substring starts, so a test names what it points at rather than counting characters. */
const at = (needle: string, occurrence = 1) => {
  let index = -1;
  for (let i = 0; i < occurrence; i += 1) index = SOURCE.indexOf(needle, index + 1);
  return index;
};

const serviceWith = (manifest?: ReturnType<typeof defineTarget>) => {
  const service = createService({ registry: registry(), manifest });
  service.open('a.drs', SOURCE);
  return service;
};

const FULL = defineTarget('full', ['drift/audio']);
const BARE = defineTarget('web-min', []);

describe('hover', () => {
  it('shows a capability with its signature, its effects and its determinism', () => {
    const result = serviceWith(FULL).hover('a.drs', at('play', 2));
    expect(result?.contents).toContain('drift/audio.play');
    expect(result?.contents).toContain('fn(slot: String) -> void');
    expect(result?.contents).toContain('audio.write');
    expect(result?.contents).toContain('deterministic: no');
    expect(result?.contents).toContain('Play a resolved sound slot');
  });

  it('says when the configured target will not link a capability', () => {
    const result = serviceWith(BARE).hover('a.drs', at('play', 2));
    expect(result?.contents).toContain('not provided by target');
    expect(result?.contents).toContain('web-min');
  });

  it('shows a declaration with what was written, including its annotation', () => {
    const result = serviceWith(FULL).hover('a.drs', at('shut'));
    expect(result?.contents).toContain('@deterministic');
    expect(result?.contents).toContain('fn shut(door: mut Door)');
  });

  it('shows a record declaration', () => {
    const result = serviceWith(FULL).hover('a.drs', at('Door'));
    expect(result?.contents).toBe('data Door');
  });

  it('shows a primitive as a type', () => {
    const result = serviceWith(FULL).hover('a.drs', at('bool'));
    expect(result?.contents).toContain('primitive type');
  });

  it('answers nothing over whitespace', () => {
    expect(serviceWith(FULL).hover('a.drs', SOURCE.indexOf('\n\n') + 1)).toBeNull();
  });
});

describe('go to definition', () => {
  it('jumps from a use to the declaration', () => {
    const service = serviceWith(FULL);
    const result = service.definition('a.drs', at('Door', 2));
    expect(result).not.toBeNull();
    expect(SOURCE.slice(result?.span.start, result?.span.end)).toBe('Door');
    /* The *declaration's* name, not the use — the first occurrence is in `data Door`. */
    expect(result?.span.start).toBe(at('Door'));
  });

  it('jumps from a capability to the import that asked for it', () => {
    const service = serviceWith(FULL);
    const result = service.definition('a.drs', at('play', 2));
    expect(SOURCE.slice(result?.span.start, result?.span.end)).toContain('import { play, stop }');
  });
});

describe('completion is capability-true', () => {
  it('offers a module\'s capabilities after its namespace and a dot', () => {
    const items = serviceWith(FULL).completions('a.drs', at('audio.play') + 'audio.'.length);
    expect(items.map((i) => i.label).sort()).toEqual(['play', 'stop']);
    expect(items.every((i) => i.kind === 'capability')).toBe(true);
  });

  it('shows a capability as available when the target provides it', () => {
    const items = serviceWith(FULL).completions('a.drs', at('audio.play') + 'audio.'.length);
    expect(items.every((i) => i.available)).toBe(true);
    expect(items[0].detail).toContain('audio.write');
  });

  it('offers an unavailable capability marked, rather than hiding it', () => {
    /* Hiding teaches a script author the surface does not exist. Showing it greyed with the reason
       teaches them it exists and their target does not provide it — which is true and actionable. */
    const items = serviceWith(BARE).completions('a.drs', at('audio.play') + 'audio.'.length);
    expect(items).toHaveLength(2);
    expect(items.every((i) => !i.available)).toBe(true);
    expect(items[0].detail).toContain('not provided by target');
    expect(items[0].detail).toContain('web-min');
  });

  it('offers keywords, primitives and this file\'s declarations elsewhere', () => {
    const items = serviceWith(FULL).completions('a.drs', at('door.open'));
    const labels = items.map((i) => i.label);
    expect(labels).toContain('fn');
    expect(labels).toContain('f32');
    expect(labels).toContain('Door');
    expect(labels).toContain('shut');
    expect(labels).toContain('audio');
  });

  it('offers a consumer-defined capability without this package knowing the consumer', () => {
    /* `drift/ecs.query` is registered by the test rather than by anything in this package. That it
       completes is the registry being one source of truth. */
    const custom = createRegistry();
    custom.add(
      defineCapability({
        module: 'drift/custom',
        name: 'somethingNobodyHereKnowsAbout',
        signature: 'fn() -> void',
        params: [],
        returns: 'void',
        effects: ['host'],
        deterministic: false,
        doc: 'A capability this package has never heard of.',
        implementation: 'Host.thing',
      }),
    );
    const service = createService({ registry: custom });
    const source = 'import { somethingNobodyHereKnowsAbout } from "drift/custom"\n\nfn f() {\n    custom.\n}\n';
    service.open('b.drs', source);
    const items = service.completions('b.drs', source.indexOf('custom.') + 'custom.'.length);
    expect(items.map((i) => i.label)).toEqual(['somethingNobodyHereKnowsAbout']);
  });

  it('agrees with the linker about what is available, over the whole registry', () => {
    /* Two readings of one fact, made to check each other: a module completion marks unavailable
       exactly when `providesModule` says the target does not provide it. */
    const service = serviceWith(BARE);
    const items = service.completions('a.drs', at('door.open'));
    const audio = items.find((i) => i.label === 'audio');
    expect(audio?.available).toBe(false);
  });
});

describe('semantic tokens', () => {
  const tokensOf = (manifest?: ReturnType<typeof defineTarget>) =>
    serviceWith(manifest).semanticTokens('a.drs');

  const tokenFor = (needle: string, occurrence: number, manifest?: ReturnType<typeof defineTarget>) => {
    const offset = at(needle, occurrence);
    return tokensOf(manifest).find((t) => t.span.start === offset);
  };

  it('classifies a capability call as a capability, not as a variable', () => {
    expect(tokenFor('play', 2, FULL)?.type).toBe('capability');
  });

  it('carries the effect a capability has, so a reader sees which lines touch the world', () => {
    expect(tokenFor('play', 2, FULL)?.modifiers).toContain('audio.write');
  });

  it('marks a capability the target cannot link', () => {
    expect(tokenFor('play', 2, BARE)?.modifiers).toContain('unavailable');
    expect(tokenFor('play', 2, FULL)?.modifiers).not.toContain('unavailable');
  });

  it('carries determinism from the enclosing function', () => {
    const inside = tokenFor('door', 2, FULL);
    expect(inside?.modifiers).toContain('deterministic');
    const outside = tokenFor('play', 2, FULL);
    expect(outside?.modifiers).not.toContain('deterministic');
  });

  it('classifies a primitive as a type and a control keyword as a keyword', () => {
    expect(tokenFor('bool', 1, FULL)?.type).toBe('type');
    expect(tokenFor('fn', 1, FULL)?.type).toBe('keyword');
  });

  it('classifies comments, strings, numbers and annotations', () => {
    const source = '// a comment\n@deterministic\nfn f() -> f32 {\n    return 250ms\n}\n';
    const service = createService({ registry: registry() });
    service.open('c.drs', source);
    const types = new Set(service.semanticTokens('c.drs').map((t) => t.type));
    expect(types).toContain('comment');
    expect(types).toContain('annotation');
    expect(types).toContain('number');
  });

  it('covers every token in the file, so nothing renders unclassified', () => {
    const tokens = tokensOf(FULL);
    /* Not a count — a count agrees while a whole category is missing. Every non-eof token's span
       must appear exactly once. */
    const spans = new Set(tokens.map((t) => `${t.span.start}:${t.span.end}`));
    expect(spans.size).toBe(tokens.length);
    expect(tokens.length).toBeGreaterThan(30);
  });
});

describe('document symbols', () => {
  it('lists every declaration with its children', () => {
    const symbols = serviceWith(FULL).documentSymbols('a.drs');
    expect(symbols.map((s) => [s.kind, s.name])).toEqual([
      ['data', 'Door'],
      ['fn', 'shut'],
      ['fn', 'ring'],
    ]);
    expect(symbols[0].children.map((c) => c.name)).toEqual(['open']);
  });

  it('points a symbol at its own name rather than at the whole declaration', () => {
    const [door] = serviceWith(FULL).documentSymbols('a.drs');
    expect(SOURCE.slice(door.nameSpan.start, door.nameSpan.end)).toBe('Door');
    expect(SOURCE.slice(door.span.start, door.span.end)).toContain('open: bool');
  });

  it('still lists what it can when the file does not parse', () => {
    /* An editor that goes blank on the first unbalanced brace is an editor people turn off. */
    const service = createService({ registry: registry() });
    service.open('d.drs', 'data Door {\n    open: bool = false\n}\n\nfn broken(( {\n}\n');
    expect(service.documentSymbols('d.drs').map((s) => s.name)).toContain('Door');
  });
});

describe('signature help', () => {
  const SOURCE =
    'import { play } from "drift/audio"\n\n' +
    'fn mix(slot: String, gain: f32, fade: f32) {\n}\n\n' +
    'fn go() {\n    audio.play("x")\n    mix("a", 1, 2)\n}\n';

  const at = (needle: string, offsetIntoNeedle = needle.length) =>
    SOURCE.indexOf(needle) + offsetIntoNeedle;

  const service = () => {
    const s = createService({ registry: registry(), manifest: FULL });
    s.open('a.drs', SOURCE);
    return s;
  };

  it('shows a capability parameter names from the registry', () => {
    const help = service().signatureHelp('a.drs', at('audio.play('));
    expect(help?.label).toBe('play(slot: String) -> void');
    expect(help?.parameters).toEqual(['slot: String']);
    expect(help?.activeParameter).toBe(0);
  });

  it('carries the capability documentation, which is why a person opened it', () => {
    expect(service().signatureHelp('a.drs', at('audio.play('))?.documentation).toContain(
      'Play a resolved sound slot',
    );
  });

  it('shows a local function parameters from its declaration', () => {
    const help = service().signatureHelp('a.drs', at('mix("a"', 4));
    expect(help?.label).toBe('mix(slot: String, gain: f32, fade: f32)');
    expect(help?.parameters).toEqual(['slot: String', 'gain: f32', 'fade: f32']);
  });

  it('advances the active parameter past each comma', () => {
    const help = service().signatureHelp('a.drs', at('mix("a", 1', 10));
    expect(help?.activeParameter).toBe(1);
  });

  it('counts only the commas of this call, not those of a nested one', () => {
    /* A comma inside a nested argument list belongs to the inner call. Counting every comma back to
       the open paren is the obvious first write and reports the wrong parameter the moment anybody
       nests a call, which in a behaviour script is immediately. */
    const source = 'fn two(a: f32, b: f32) -> f32 {\n    return a\n}\n\nfn go() {\n    two(two(1, 2), 3)\n}\n';
    const s = createService({ registry: registry(), manifest: FULL });
    s.open('b.drs', source);
    const help = s.signatureHelp('b.drs', source.indexOf('two(two(1, 2), 3') + 'two(two(1, 2), '.length);
    expect(help?.label).toBe('two(a: f32, b: f32) -> f32');
    expect(help?.activeParameter).toBe(1);
  });

  it('answers nothing outside a call', () => {
    expect(service().signatureHelp('a.drs', at('fn go()'))).toBeNull();
  });

  it('answers nothing for a callee it cannot name', () => {
    const s = createService({ registry: registry(), manifest: FULL });
    s.open('c.drs', 'fn go() {\n    nosuch(1)\n}\n');
    expect(s.signatureHelp('c.drs', 'fn go() {\n    nosuch('.length)).toBeNull();
  });
});

describe('a record with a base, in the editor', () => {
  const SRC = 'data Dog {\n    energy: f32 = 1\n}\n\ndata Wolf : Dog {\n    packSize: i32 = 0\n}\n';
  const open = () => {
    const s = createService({ registry: registry(), manifest: FULL });
    s.open('a.drs', SRC);
    return s;
  };

  it('shows the base in the outline', () => {
    /* A subtype shown as `data Wolf` hides the half of its shape that is not written in it, which is
       most of it once a chain is two deep. */
    expect(open().documentSymbols('a.drs').map((d) => d.detail)).toEqual([
      'data Dog',
      'data Wolf : Dog',
    ]);
  });

  it('colours the base name as a type, not as a variable', () => {
    /* The grammar highlights it statically; this is the live pass, and the two must agree or a file
       changes colour as the server starts. */
    const at = SRC.indexOf('Dog', SRC.indexOf('Wolf'));
    const token = open()
      .semanticTokens('a.drs')
      .find((t) => t.span.start === at);
    expect(token?.type).toBe('type');
  });

  it('hovers the base as the record it is', () => {
    const at = SRC.indexOf('Dog', SRC.indexOf('Wolf'));
    expect(open().hover('a.drs', at)?.contents).toContain('Dog');
  });
});
