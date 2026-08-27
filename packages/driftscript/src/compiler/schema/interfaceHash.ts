/**
 * A hash of everything about a module that another module can depend on.
 *
 * This is what makes incremental work possible: a body-only edit leaves it identical, so nothing
 * downstream recompiles, and a signature or record change moves it, so everything downstream does.
 * The Vite transform invalidates dependents on it, and the language server schedules on it.
 *
 * **What goes in is the interface and only the interface**: record names, their fields in order,
 * each field's type, function names, parameter names and types, and return types. Not statement
 * bodies, not spans, not comments, not whitespace — an edit that changes only how something is
 * done cannot change what depends on it.
 *
 * The cost is that a body edit which changes *behaviour* still recompiles nothing downstream,
 * which is correct for a compiler and would be wrong for a test runner. What would make it wrong
 * here is a language where a body can widen an interface — a return type inferred from a body,
 * say — and this language declares its return types for exactly that reason.
 *
 * Field **order** is included deliberately. It does not affect what a caller may write, but it
 * does affect what a hot patch can migrate, and a hash that ignored it would call two different
 * record layouts the same.
 */
import type { IrExpr, IrModule } from '../ir/ir.ts';
import { typeKey } from './typeKey.ts';

/**
 * A field's default, as text that changes when the value does and not when the layout does.
 *
 * **Spans are stripped, so reformatting a file does not move its interface.** Everything else is
 * kept, including the shape of a computed default, because anything dropped here is a change a
 * dependent would not be told about.
 */
function defaultKey(init: IrExpr): string {
  return JSON.stringify(init, (key, value) => (key === 'span' ? undefined : value));
}

/**
 * FNV-1a, 32 bits, hex.
 *
 * Chosen because it is eight lines and has no dependency — the same argument the VLQ encoder makes.
 * It is not cryptographic and does not need to be: this compares a module against its own previous
 * version in one process, where an adversary would have to be the author. What would make it wrong
 * is using it to decide whether to *trust* a module rather than whether to recompile one.
 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function interfaceHash(ir: IrModule, dependencies: readonly string[] = []): string {
  const parts: string[] = [];

  /*
   * What this module uses from the modules it imports.
   *
   * **The names it actually imported, rather than each dependency's whole interface**, which is a
   * deliberate departure from what the design specified. Hashing whole dependencies would move this
   * module's
   * interface when a file it imports changes something it never touches — and in a project where
   * one module is imported widely, that makes every edit to it a full rebuild. It would also need
   * the hash to recurse, which does not terminate on a cycle and is why §8 had to reach for
   * strongly-connected components.
   *
   * Hashing the used names is stronger and simpler: it moves for exactly the changes that can
   * affect what this module compiles to, and a cycle is not a special case because nothing recurses.
   */
  if (dependencies.length > 0) parts.push(`uses ${[...dependencies].sort().join(',')}`);

  /*
   * A record's **defaults are part of its interface**, not only its field names and types.
   *
   * That is a consequence of a subtype inlining its base's defaults into its own constructor. Change
   * `energy: f32 = 7` to `= 9` in one file and a subtype in another file emits a different literal —
   * so if this hash ignored the value, the subtype would never be told to recompile and would go on
   * emitting `7`. A wrong value, silently, which is the failure mode a hash exists to prevent rather
   * than to cause.
   *
   * The cost is that editing any default recompiles every dependent, including the many that only
   * call a function. What would make that wrong is defaults changing as often as bodies do, and they
   * do not: a default is part of what a record *is*.
   */
  for (const data of ir.data) {
    const fields = data.fields
      .map((f) => `${f.name}:${typeKey(f.type)}=${defaultKey(f.init)}`)
      .join(',');
    parts.push(`data ${data.name}(${fields})`);
  }
  /*
   * A variant's payload is part of the enum, and the enum is part of the interface.
   *
   * An enum is importable, so a dependent's `match` has an exhaustiveness check against exactly
   * this list. Left out — as it was until a test asked — a dependent goes on being compiled against
   * a set of variants that is no longer the set, and the `match` it was checked against is one a
   * new variant should have reopened.
   */
  for (const enumeration of ir.enums) {
    const variants = enumeration.variants
      .map((v) => `${v.name}${v.hasPayload ? '(_)' : ''}`)
      .join(',');
    parts.push(`enum ${enumeration.name}(${variants})`);
  }

  /*
   * **The return type, which was missing.** A hash reading only the parameters cannot tell
   * `fn measure(at: f32) -> f32` from `fn measure(at: f32) -> i32`, so a dependent goes on holding
   * a value of a type the function no longer returns. Found by a test that changed nothing else.
   */
  for (const fn of ir.fns) {
    const params = fn.params.map((p) => `${p.name}:${typeKey(p.type)}`).join(',');
    parts.push(`fn ${fn.name}(${params})->${typeKey(fn.returns)}`);
  }

  /*
   * Tasks, events and state machines are deliberately absent.
   *
   * None of them crosses a module boundary: `IrImport.values` carries enums and functions, so a
   * dependent cannot name a task, listen for an event by importing it, or reach a state. A change
   * to one cannot change what a dependent compiles to, and hashing it would recompile dependents
   * for edits they cannot observe.
   *
   * **What would make this wrong** is making any of the three importable, which is the day this
   * paragraph has to be deleted rather than qualified.
   */

  /*
   * Requirements are part of the interface.
   *
   * A module that starts importing `drift/audio` links differently even if nothing else about it
   * changed, and a dependent compiled against the old requirements would be compiled against a
   * target decision that no longer holds.
   */
  parts.push(`requires ${[...ir.requires].sort().join(',')}`);

  /* Sorted, so declaration order does not change the hash — two modules with the same interface
     written in a different order are the same interface, and a reorder should recompile nothing. */
  return fnv1a(parts.sort().join(';'));
}
