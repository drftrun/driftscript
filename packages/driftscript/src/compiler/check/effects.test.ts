import { describe, expect, it } from 'vitest';
import { parse } from '../parser.ts';
import { checkEffects } from './effects.ts';
import { createRegistry, defineCapability } from '../../registry/capability.ts';

/**
 * A registry with one capability per interesting effect.
 *
 * Built here rather than imported from the engine bindings, because this package must not reach the
 * engine — and because a test that used real bindings would be testing them rather than inference.
 */
const registry = () => {
  const r = createRegistry();
  r.add(
    defineCapability({
      module: 'drift/audio',
      name: 'play',
      signature: 'fn(sound: Sound) -> void',
      params: [{ name: 'sound', type: 'Sound' }],
      returns: 'void',
      effects: ['audio.write'],
      deterministic: false,
      doc: 'Play a sound.',
      implementation: 'AudioGraph.play',
    }),
  );
  r.add(
    defineCapability({
      module: 'drift/time',
      name: 'wallClock',
      signature: 'fn() -> f32',
      params: [],
      returns: 'f32',
      effects: ['clock.read'],
      deterministic: false,
      doc: 'Read the wall clock.',
      implementation: 'Loop.wall',
    }),
  );
  r.add(
    defineCapability({
      module: 'drift/random',
      name: 'unit',
      signature: 'fn(seed: u32) -> f32',
      params: [{ name: 'seed', type: 'u32' }],
      returns: 'f32',
      effects: ['pure'],
      deterministic: true,
      doc: 'A seeded value from a frozen sequence.',
      implementation: 'rng.hashToUnit',
    }),
  );
  r.add(
    defineCapability({
      module: 'drift/scene',
      name: 'position',
      signature: 'fn(node: Node) -> Vec3',
      params: [{ name: 'node', type: 'Node' }],
      returns: 'Vec3',
      effects: ['scene.read'],
      deterministic: true,
      doc: "Read a node's position.",
      implementation: 'SceneNode.position',
    }),
  );
  r.add(
    defineCapability({
      module: 'drift/ai',
      name: 'ask',
      signature: 'fn(prompt: String) -> String',
      params: [{ name: 'prompt', type: 'String' }],
      returns: 'String',
      effects: ['ai'],
      deterministic: false,
      doc: 'Ask a model.',
      implementation: 'AiSession.ask',
    }),
  );
  return r;
};

const check = (source: string) => checkEffects(parse(source, 'a.drs').module, registry(), 'a.drs');

const effectsOf = (source: string, fn: string) => [...(check(source).effects.get(fn) ?? [])].sort();
const codesOf = (source: string) => check(source).diagnostics.map((d) => d.code);

describe('effect inference', () => {
  it('infers an effect from a capability call, with no annotation anywhere', () => {
    const source =
      'import { play } from "drift/audio"\n\nfn ring() {\n    audio.play(1)\n}\n';
    expect(effectsOf(source, 'ring')).toEqual(['audio.write']);
  });

  it('propagates an effect through a call', () => {
    const source =
      'import { play } from "drift/audio"\n\nfn ring() {\n    audio.play(1)\n}\n\nfn open() {\n    ring()\n}\n';
    expect(effectsOf(source, 'open')).toEqual(['audio.write']);
  });

  it('propagates through a chain, and to a caller declared above the callee', () => {
    const source =
      'import { play } from "drift/audio"\n\nfn outer() {\n    middle()\n}\n\nfn middle() {\n    inner()\n}\n\nfn inner() {\n    audio.play(1)\n}\n';
    expect(effectsOf(source, 'outer')).toEqual(['audio.write']);
  });

  it('gives a function that calls nothing effectful no effects at all', () => {
    expect(effectsOf('fn add(a: f32, b: f32) -> f32 {\n    return a + b\n}\n', 'add')).toEqual([]);
  });

  it('terminates on mutual recursion rather than looping forever', () => {
    const source =
      'import { play } from "drift/audio"\n\nfn a() {\n    b()\n}\n\nfn b() {\n    a()\n    audio.play(1)\n}\n';
    expect(effectsOf(source, 'a')).toEqual(['audio.write']);
  });
});

describe('@pure', () => {
  it('accepts a function that computes', () => {
    expect(codesOf('@pure\nfn squared(x: f32) -> f32 {\n    return x * x\n}\n')).toEqual([]);
  });

  it('refuses a function that reaches a capability', () => {
    const source =
      'import { play } from "drift/audio"\n\n@pure\nfn ring() {\n    audio.play(1)\n}\n';
    expect(codesOf(source)).toContain('DS0260');
  });

  it('refuses a function that reaches one indirectly', () => {
    const source =
      'import { play } from "drift/audio"\n\nfn ring() {\n    audio.play(1)\n}\n\n@pure\nfn open() {\n    ring()\n}\n';
    expect(codesOf(source)).toContain('DS0260');
  });
});

describe('@deterministic, grounded on the boundary the engine already draws', () => {
  it('accepts a function that only computes', () => {
    expect(codesOf('@deterministic\nfn squared(x: f32) -> f32 {\n    return x * x\n}\n')).toEqual([]);
  });

  it('accepts a seeded generator, because a frozen sequence is deterministic by construction', () => {
    const source =
      'import { unit } from "drift/random"\n\n@deterministic\nfn jitter(seed: u32) -> f32 {\n    return random.unit(seed)\n}\n';
    expect(codesOf(source)).toEqual([]);
  });

  it('accepts reading simulation state, which is inside the boundary', () => {
    const source =
      'import { position } from "drift/scene"\n\n@deterministic\nfn look(node: f32) -> f32 {\n    return scene.position(node)\n}\n';
    expect(codesOf(source)).toEqual([]);
  });

  it('refuses a wall clock, which is what the rule is actually about', () => {
    const source =
      'import { wallClock } from "drift/time"\n\n@deterministic\nfn now() -> f32 {\n    return time.wallClock()\n}\n';
    expect(codesOf(source)).toContain('DS0261');
  });

  it('refuses audio, because the engine places it outside the boundary', () => {
    const source =
      'import { play } from "drift/audio"\n\n@deterministic\nfn ring() {\n    audio.play(1)\n}\n';
    expect(codesOf(source)).toContain('DS0261');
  });

  it('refuses an AI call from a deterministic context', () => {
    const source =
      'import { ask } from "drift/ai"\n\n@deterministic\nfn decide() -> String {\n    return ai.ask("what")\n}\n';
    expect(codesOf(source)).toContain('DS0261');
  });

  it('refuses one reached indirectly, through a function nobody annotated', () => {
    const source =
      'import { play } from "drift/audio"\n\nfn ring() {\n    audio.play(1)\n}\n\n@deterministic\nfn open() {\n    ring()\n}\n';
    expect(codesOf(source)).toContain('DS0261');
  });

  it('names the capability it reached, not only the effect', () => {
    const source =
      'import { play } from "drift/audio"\n\n@deterministic\nfn ring() {\n    audio.play(1)\n}\n';
    const [diagnostic] = check(source).diagnostics;
    expect(diagnostic.message).toContain('audio.write');
    expect(diagnostic.message).toContain('drift/audio.play');
  });

  it('reports an effect as a property of the code, whether or not a target links it', () => {
    /* Availability is the linker's question and is asked elsewhere. A file using an unprovided
       surface still has that surface's effects, which is what lets it be checked before the
       provider ships. */
    const source =
      'import { play } from "drift/audio"\n\nfn ring() {\n    audio.play(1)\n}\n';
    expect(effectsOf(source, 'ring')).toEqual(['audio.write']);
  });
});

describe('every statement kind is walked, and three were not', () => {
  /*
   * **`calleesOf` switched over seven statement kinds and had no `default`.** A kind it did not
   * name was skipped in silence, and a skipped statement means every call inside it is invisible to
   * inference — so an annotation asserting purity passed for code that was not pure.
   *
   * Adding the query loop is what surfaced it, and making the switch exhaustive is what showed the
   * gap was three kinds wide rather than one. `emit` and `spawn` are legal in a plain function and
   * were both live; `await` and `scope` are refused outside a task and so were unreachable, but are
   * walked now rather than left as the next reachable gap.
   */
  it('sees an effect in a value emitted with an event', () => {
    const source = `
import { play } from "drift/audio"
import { wallClock } from "drift/time"

event Ping { at: f64 = 0 }

fn emits() {
    emit Ping { at: time.wallClock() }
}
`;
    expect(effectsOf(source, 'emits')).toEqual(['clock.read']);
  });

  it('sees an effect in an argument to a spawn', () => {
    const source = `
import { wallClock } from "drift/time"

task worker(at: f32) {
}

fn starts() {
    spawn worker(time.wallClock())
}
`;
    expect(effectsOf(source, 'starts')).toEqual(['clock.read']);
  });

  it('refuses `@deterministic` on a function whose only clock read is inside an emit', () => {
    const source = `
import { wallClock } from "drift/time"

event Ping { at: f64 = 0 }

@deterministic
fn emits() {
    emit Ping { at: time.wallClock() }
}
`;
    expect(check(source).diagnostics.length).toBeGreaterThan(0);
  });
});

describe('a query loop body is walked like any other body', () => {
  /*
   * **This was a live gap the moment the query loop landed.** `calleesOf` switches over statement
   * kinds with no `default`, so a kind it does not name is silently skipped — and a skipped
   * statement means every call inside it is invisible to inference. A `@deterministic` function
   * would have passed while playing audio, as long as the call sat inside a `for`.
   *
   * Nothing failed when it went wrong, which is why this is written as three cases rather than one:
   * the effect must be seen, the annotation must be refused, and the propagation must still reach
   * through a helper called from inside the loop.
   */
  const SOURCE = `
import { play } from "drift/audio"

fn inLoop() {
    for e in query<Hunger>() {
        audio.play(1)
    }
}
`;

  it('sees an effect from a call inside a query loop', () => {
    expect(effectsOf(SOURCE, 'inLoop')).toEqual(['audio.write']);
  });

  it('refuses `@deterministic` on a function whose only effect is inside a query loop', () => {
    const source = `
import { play } from "drift/audio"

@deterministic
fn inLoop() {
    for e in query<Hunger>() {
        audio.play(1)
    }
}
`;
    expect(check(source).diagnostics.length).toBeGreaterThan(0);
  });

  it('propagates through a helper called from inside a query loop', () => {
    const source = `
import { play } from "drift/audio"

fn helper() {
    audio.play(1)
}

fn inLoop() {
    for e in query<Hunger>() {
        helper()
    }
}
`;
    expect(effectsOf(source, 'inLoop')).toEqual(['audio.write']);
  });

  it('sees an effect in the condition-free parts a loop nests', () => {
    const source = `
import { play } from "drift/audio"

fn nested() {
    for e in query<Hunger>() {
        if true {
            audio.play(1)
        }
    }
}
`;
    expect(effectsOf(source, 'nested')).toEqual(['audio.write']);
  });
});
