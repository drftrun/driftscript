/**
 * Open documents, and the one conversion every editor feature needs.
 *
 * The compiler speaks byte offsets, because a span is two numbers and arithmetic on them is cheap.
 * An editor speaks lines and characters. Converting at this boundary rather than carrying both is
 * what keeps a token to two numbers — and this is the only place the two representations meet, so
 * an off-by-one lives here or nowhere.
 *
 * **Line starts are cached per document version**, because a hover asks for one offset and a
 * semantic-token pass asks for thousands. Recomputing per query is a scan of the file each time;
 * the cache is one scan per edit.
 */

/** A zero-based line and character, which is what the language server protocol counts in. */
export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface Document {
  readonly uri: string;
  readonly text: string;
  /** Bumped on every edit. What the incremental scheduler and the cache key on. */
  readonly version: number;
  offsetAt(position: Position): number;
  positionAt(offset: number): Position;
  rangeOf(span: { start: number; end: number }): Range;
}

function lineStarts(text: string): readonly number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

export function createDocument(uri: string, text: string, version = 1): Document {
  const starts = lineStarts(text);

  const positionAt = (offset: number): Position => {
    const clamped = Math.max(0, Math.min(offset, text.length));
    /* Binary search rather than a scan: a semantic-token pass converts one offset per token, and a
       large file has thousands. The linear version was the obvious first write and is quadratic
       over a document. */
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (starts[mid] <= clamped) low = mid;
      else high = mid - 1;
    }
    return { line: low, character: clamped - starts[low] };
  };

  const offsetAt = (position: Position): number => {
    if (position.line < 0) return 0;
    if (position.line >= starts.length) return text.length;
    const start = starts[position.line];
    const end = position.line + 1 < starts.length ? starts[position.line + 1] : text.length;
    return Math.min(start + Math.max(0, position.character), end);
  };

  return {
    uri,
    text,
    version,
    offsetAt,
    positionAt,
    rangeOf: (span) => ({ start: positionAt(span.start), end: positionAt(span.end) }),
  };
}

export interface DocumentStore {
  open(uri: string, text: string): Document;
  change(uri: string, text: string): Document;
  close(uri: string): void;
  get(uri: string): Document | undefined;
  all(): readonly Document[];
}

export function createDocumentStore(): DocumentStore {
  const documents = new Map<string, Document>();

  return {
    open(uri, text) {
      const document = createDocument(uri, text, 1);
      documents.set(uri, document);
      return document;
    },
    change(uri, text) {
      const previous = documents.get(uri);
      const document = createDocument(uri, text, (previous?.version ?? 0) + 1);
      documents.set(uri, document);
      return document;
    },
    close(uri) {
      documents.delete(uri);
    },
    get(uri) {
      return documents.get(uri);
    },
    all() {
      return [...documents.values()];
    },
  };
}
