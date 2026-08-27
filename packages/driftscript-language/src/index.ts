/**
 * The language server's barrel.
 *
 * Empty of features until the server itself lands, and created now rather than then because
 * `scripts/version.test.mjs` asserts the *count* of packages on each version line. A package that
 * arrives later arrives without that assertion having ever seen it absent — and a count is only a
 * guard while it is one somebody has watched fail.
 */

/** The server's name, as an editor client addresses it. */
export const SERVER_NAME = 'driftscript-language';

export type { Document, DocumentStore, Position, Range } from './documents.ts';
export { createDocument, createDocumentStore } from './documents.ts';

export type { Analysis, Declaration, Target } from './analysis.ts';
export { analyse, targetAt, tokenAt } from './analysis.ts';

export type { CompletionItem, Hover, Location, SemanticToken, SignatureHelp } from './features.ts';
export {
  completions,
  definition,
  documentSymbols,
  hover,
  semanticTokens,
  signatureHelp,
} from './features.ts';

export type { CodeAction, RenameResult, TextEdit } from './edits.ts';
export { applyEdits, codeActions, references, rename } from './edits.ts';

export type { Schedule, ScheduleWorkspace, Scheduler } from './schedule.ts';
export { createScheduler } from './schedule.ts';

export type { PublishedDiagnostic, Service, ServiceOptions } from './service.ts';
export { createService } from './service.ts';
