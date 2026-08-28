/**
 * `uses` — the clause that hands a system a value it could not otherwise have.
 *
 * **The gap a consumer reported, in their words:** an opaque handle enters a script only as a
 * capability parameter, so a `fn` can take a path or a graph and a `system` can take nothing at
 * all. What that cost them was the loop: the host kept a path per agent and called a plain function
 * once per agent per step, so the rule stayed hot-reloadable and the walk over entities moved into
 * TypeScript — out of the schedule, out of the declared-access checks, and out of step with the
 * query it replaced.
 *
 * The report offered two shapes and this is the second. The first — a component field holding a
 * handle — is refused, and `ast.ts` records why beside the declaration: a component is what a save
 * file holds, and a host object has no stable id, no constant a prefab could give it, and nothing
 * for a scene load to rewrite.
 */
import { describe, expect, it } from 'vitest';
import { parse } from '../parser.ts';
import { check } from './checker.ts';
import { lower } from '../ir/lower.ts';
import { emitJs } from '../emit/js.ts';
import { entityMetadata } from '../emit/entityMeta.ts';
import { createRegistry, defineCapability } from '../../registry/capability.ts';

/** A host that has a navigation graph and can answer an agent's path from it. */
const registry = () => {
  const r = createRegistry();
  r.addType({ module: 'drift/ecs', name: 'World', doc: 'A world.' });
  r.addType({ module: 'drift/navigation', name: 'NavGraph', doc: 'What a world navigates.' });
  r.addType({ module: 'drift/navigation', name: 'NavPath', doc: 'A route an agent follows.' });
  r.add(
    defineCapability({
      module: 'drift/navigation',
      name: 'pathOf',
      signature: 'fn(graph: NavGraph, e: Entity) -> NavPath',
      params: [
        { name: 'graph', type: 'NavGraph' },
        { name: 'e', type: 'Entity' },
      ],
      returns: 'NavPath',
      effects: ['navigation.read'],
      deterministic: true,
      doc: 'The path this agent is following.',
      implementation: 'navigation.pathOf',
    }),
  );
  r.add(
    defineCapability({
      module: 'drift/navigation',
      name: 'remaining',
      signature: 'fn(path: NavPath) -> f64',
      params: [{ name: 'path', type: 'NavPath' }],
      returns: 'f64',
      effects: ['navigation.read'],
      deterministic: true,
      doc: 'Metres left to walk.',
      implementation: 'navigation.remaining',
    }),
  );
  return r;
};

const errorsIn = (source: string): { code: string; message: string }[] => {
  const parsed = parse(source, 'm.drs');
  const parseErrors = parsed.diagnostics.filter((d) => d.severity === 'error');
  if (parseErrors.length > 0) {
    return parseErrors.map((d) => ({ code: d.code, message: d.message }));
  }
  return check(parsed.module, 'm.drs', registry())
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => ({ code: d.code, message: d.message }));
};

/** Compile the whole way, because what a resource *is* only becomes visible in the output. */
const compiled = (source: string) => {
  const parsed = parse(source, 'm.drs');
  expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const checked = check(parsed.module, 'm.drs', registry());
  expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const ir = lower(parsed.module, checked);
  return {
    ...emitJs(ir, { filename: 'm.drs', source }),
    metadata: entityMetadata(ir, 'development'),
  };
};

const WALK =
  'import { pathOf, remaining } from "drift/navigation"\n\n' +
  'component Placement {\n    speed: f64 = 0\n}\n\n' +
  'system Walk {\n' +
  '    uses graph: NavGraph\n' +
  '    writes Placement\n\n' +
  '    update {\n' +
  '        for e in query<Placement>() {\n' +
  '            let path = navigation.pathOf(graph, e)\n' +
  '            e.Placement.speed = navigation.remaining(path)\n' +
  '        }\n' +
  '    }\n' +
  '}\n';

describe('a system can be handed a host value', () => {
  it('binds the name in the body, so the loop stays in the script', () => {
    expect(errorsIn(WALK)).toEqual([]);
  });

  it('takes a second parameter and unpacks it by type', () => {
    /* Keyed by type rather than by name: a host is asked for "the `NavGraph` this world has" and
       never has to learn that this file calls it `graph`. */
    const { code } = compiled(WALK);
    expect(code).toContain('export function Walk(world, $res) {');
    expect(code).toContain('const graph = $res["NavGraph"];');
  });

  it('leaves a system with no resources exactly as it was', () => {
    /*
     * **The quiet form stays quiet**, which is what lets a host pass the second argument to every
     * system unconditionally. A parameter emitted always would be a diff in every shipped module
     * for a feature almost none of them use.
     */
    const { code } = compiled(
      'component Placement {\n    speed: f64 = 0\n}\n\n' +
        'system Still {\n    writes Placement\n\n    update {\n' +
        '        for e in query<Placement>() {\n            e.Placement.speed = 0\n        }\n' +
        '    }\n}\n',
    );
    expect(code).toContain('export function Still(world) {');
    expect(code).not.toContain('$res');
  });

  it('tells a host what to supply, by type', () => {
    expect(compiled(WALK).metadata.systems).toEqual([
      expect.objectContaining({ name: 'Walk', uses: [{ name: 'graph', type: 'NavGraph' }] }),
    ]);
  });

  it('says a system needs nothing rather than leaving the question out', () => {
    /* The four-lists rule: a host reads a field rather than testing for one. */
    const { metadata } = compiled(
      'component Placement {\n    speed: f64 = 0\n}\n\n' +
        'system Still {\n    writes Placement\n\n    update {\n' +
        '        for e in query<Placement>() {\n            e.Placement.speed = 0\n        }\n' +
        '    }\n}\n',
    );
    expect(metadata.systems[0]?.uses).toEqual([]);
  });

  it('is immutable, because the host owns it', () => {
    expect(
      errorsIn(
        'import { pathOf } from "drift/navigation"\n\n' +
          'system Walk {\n    uses graph: NavGraph\n\n    update {\n' +
          '        graph = graph\n' +
          '    }\n}\n',
      ),
    ).toEqual([
      {
        code: 'DS0201',
        message: '`graph` is not declared `mut`, so it cannot be written through',
      },
    ]);
  });

  it('refuses a type this host never registered, in the words a parameter gets', () => {
    /*
     * The same refusal `fn f(graph: Compass)` produces, which is the point: a resource's type is
     * resolved by the one resolver, so a language server open on a file with no project configured
     * says the same thing about both rather than letting one of them through.
     */
    expect(
      errorsIn('system Walk {\n    uses compass: Compass\n\n    update {\n    }\n}\n'),
    ).toEqual([
      {
        code: 'DS0204',
        message: '`Compass` is not a type this module declares or imports',
      },
    ]);
  });
});

describe('the three ways a `uses` clause is wrong', () => {
  it('refuses a resource named `world`', () => {
    /* Invisible where `let world = …` is not: the clause is in the head, so every `drift/ecs` call
       in the body below would silently run against the resource instead. */
    const errors = errorsIn(
      'system Walk {\n    uses world: NavGraph\n\n    update {\n    }\n}\n',
    );
    expect(errors).toEqual([
      {
        code: 'DS0272',
        message:
          'a resource cannot be named `world`, which is already the world this system runs ' +
          'against. Every `drift/ecs` call in the body takes that name.',
      },
    ]);
  });

  it('refuses two resources of one type', () => {
    /* A host supplies one value per type, so these were always two names for one object — and the
       day somebody changes one expecting the other to hold still there is nothing to find. */
    const errors = errorsIn(
      'system Walk {\n    uses a: NavGraph\n    uses b: NavGraph\n\n    update {\n    }\n}\n',
    );
    expect(errors).toEqual([
      {
        code: 'DS0273',
        message:
          '`b` and `a` are both `NavGraph`, and a host supplies one value per type — so these ' +
          'are two names for one object rather than two resources.',
      },
    ]);
  });

  it('refuses one name declared twice', () => {
    /* `Scope.declare` overwrites, because a later `let` shadowing a name is ordinary. A head has
       no ordering to read, so the winner would be whichever line came second. */
    const errors = errorsIn(
      'system Walk {\n    uses g: NavGraph\n    uses g: NavPath\n\n    update {\n    }\n}\n',
    );
    expect(errors).toEqual([
      {
        code: 'DS0274',
        message:
          "`g` is declared twice in this system's head, so nothing in the body could say which " +
          'one it meant.',
      },
    ]);
  });

  it('names the clause it cannot parse rather than the system', () => {
    const parsed = parse('system Walk {\n    uses graph\n\n    update {\n    }\n}\n', 'm.drs');
    expect(parsed.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)).toEqual([
      'DS0103',
    ]);
  });

  it('still lists what a system body may hold when it meets something else', () => {
    const parsed = parse('system Walk {\n    borrows graph\n\n    update {\n    }\n}\n', 'm.drs');
    expect(parsed.diagnostics[0]?.message).toContain('`uses`');
  });
});

describe('`uses` is a keyword only where a system head is', () => {
  it('is still an ordinary field name', () => {
    /* A soft keyword, like `reads` and `writes` beside it. `data Stats { uses: i32 }` is a
       reasonable record and refusing it would be a language spending a common noun on a clause. */
    expect(errorsIn('data Stats {\n    uses: i32 = 0\n}\n')).toEqual([]);
  });

  it('is still an ordinary parameter name', () => {
    expect(errorsIn('fn count(uses: i32) -> i32 {\n    return uses\n}\n')).toEqual([]);
  });
});
