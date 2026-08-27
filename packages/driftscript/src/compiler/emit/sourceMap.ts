/**
 * Source map v3, written here rather than taken from a library.
 *
 * `driftscript` carries **zero runtime dependencies** — a compiler is a runtime artefact of the
 * consumer's build, and a dependency here is one every consumer of the language inherits. A VLQ
 * encoder is forty lines of bit arithmetic, which is well under the bar `ARCHITECTURE.md` §5 sets
 * for earning a dependency by argument.
 *
 * **The test reads these mappings back with `source-map-js`**, which is a devDependency and never
 * ships. That is the 2026-08-17 rule: two implementations of one decision, made to check each
 * other. A decoder written by the same hand as the encoder agrees with itself, and would have
 * agreed just as happily about an off-by-one in every mapping.
 */

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * One signed integer, base64 VLQ.
 *
 * The low bit carries the sign and each group of five bits carries a continuation flag in the
 * sixth, most-significant-group-last. The arithmetic is unreadable by nature, which is why it is
 * isolated in one function with a decoder in the test rather than spread through the emitter.
 *
 * The cost is that a bug here corrupts every mapping in the file at once. What would make it wrong
 * is a mapping emitted out of generated-line order: the format is delta-encoded and cannot express
 * a step backwards, so the emitter must write lines in the order they appear.
 */
function encodeVlq(value: number): string {
  let vlq = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = vlq & 0b11111;
    vlq >>>= 5;
    if (vlq > 0) digit |= 0b100000;
    out += BASE64[digit];
  } while (vlq > 0);
  return out;
}

export interface SourceMap {
  readonly version: 3;
  readonly file: string;
  readonly sources: readonly string[];
  readonly sourcesContent: readonly string[];
  readonly names: readonly string[];
  readonly mappings: string;
}

/** One generated position tied to one original position. */
interface Mapping {
  readonly generatedLine: number;
  readonly generatedColumn: number;
  readonly originalLine: number;
  readonly originalColumn: number;
}

/**
 * Collects mappings and encodes them once, at the end.
 *
 * Encoding as it goes would be cheaper and would also make the delta state depend on call order,
 * which is a bug that surfaces as a map that is subtly wrong rather than as one that fails. This
 * runs once per compiled file and never in a frame, so the sort is free.
 */
export class MappingBuilder {
  private readonly mappings: Mapping[] = [];

  add(mapping: Mapping): void {
    this.mappings.push(mapping);
  }

  encode(): string {
    const sorted = [...this.mappings].sort(
      (a, b) => a.generatedLine - b.generatedLine || a.generatedColumn - b.generatedColumn,
    );

    const lines: string[] = [];
    let previousSource = 0;
    let previousOriginalLine = 0;
    let previousOriginalColumn = 0;

    let line = 0;
    let previousGeneratedColumn = 0;
    let segments: string[] = [];

    const flush = () => {
      lines.push(segments.join(','));
      segments = [];
      /* The generated column resets at every line and the other three do not. Getting this wrong
         produces a map that decodes without error and points at the wrong place, which is the
         failure mode a "does it have mappings" test cannot see. */
      previousGeneratedColumn = 0;
    };

    for (const mapping of sorted) {
      while (line < mapping.generatedLine) {
        flush();
        line += 1;
      }
      segments.push(
        encodeVlq(mapping.generatedColumn - previousGeneratedColumn) +
          encodeVlq(0 - previousSource) +
          encodeVlq(mapping.originalLine - previousOriginalLine) +
          encodeVlq(mapping.originalColumn - previousOriginalColumn),
      );
      previousGeneratedColumn = mapping.generatedColumn;
      previousSource = 0;
      previousOriginalLine = mapping.originalLine;
      previousOriginalColumn = mapping.originalColumn;
    }
    flush();

    return lines.join(';');
  }
}
