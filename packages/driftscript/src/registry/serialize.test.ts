import { describe, expect, it } from 'vitest';
import { createRegistry, defineCapability } from './capability.ts';
import { registryFromJson, serializeRegistry } from './serialize.ts';

const built = () => {
  const registry = createRegistry();
  registry.addType({ module: 'drift/audio', name: 'Sound', doc: 'A resolved sound slot.' });
  registry.add(
    defineCapability({
      module: 'drift/audio',
      name: 'play',
      signature: 'fn(slot: String) -> void',
      params: [{ name: 'slot', type: 'String' }],
      returns: 'void',
      effects: ['audio.write'],
      deterministic: false,
      doc: 'Play a sound.',
      implementation: 'AudioGraph.play',
    }),
  );
  return registry;
};

describe('a registry as data', () => {
  it('survives a round trip through JSON', () => {
    const before = built();
    const after = registryFromJson(JSON.parse(JSON.stringify(serializeRegistry(before))));
    expect(after.all()).toEqual(before.all());
    expect(after.types()).toEqual(before.types());
  });

  it('carries the fields hover and completion read', () => {
    const after = registryFromJson(JSON.parse(JSON.stringify(serializeRegistry(built()))));
    const play = after.get('drift/audio', 'play');
    expect(play?.doc).toBe('Play a sound.');
    expect(play?.effects).toEqual(['audio.write']);
    expect(play?.deterministic).toBe(false);
  });

  it('validates what it reads rather than trusting the file', () => {
    /*
     * A hand-edited or half-written file is refused at the boundary. Trusting it would produce a
     * registry the compiler then reasons from, and the first sign would be a wrong answer in an
     * editor rather than a refusal where somebody can act.
     *
     * The determinism lie is the one worth asserting, because it is the check `defineCapability`
     * exists for: `@deterministic` compiles to a refusal to call anything the registry marks
     * otherwise, so a definition that lies about itself makes the compiler's guarantee false
     * everywhere at once, silently.
     */
    const data = JSON.parse(JSON.stringify(serializeRegistry(built())));
    data.capabilities[0].deterministic = true;
    expect(() => registryFromJson(data)).toThrow(/deterministic/);
  });

  it('refuses a version it does not know, rather than misreading it', () => {
    const data = JSON.parse(JSON.stringify(serializeRegistry(built())));
    data.version = 2;
    expect(() => registryFromJson(data)).toThrow(/version/);
  });

  it('holds no functions, which is what lets it cross a process boundary at all', () => {
    /* R2: a definition names its implementation as a string. If that ever stopped being true this
       whole mechanism would silently start dropping the implementation on serialisation. */
    for (const capability of serializeRegistry(built()).capabilities) {
      for (const value of Object.values(capability)) {
        expect(typeof value).not.toBe('function');
      }
    }
  });
});
