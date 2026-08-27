/**
 * How the compiler reaches a module it does not have in hand.
 *
 * The compiler reads no files of its own. It is given one of these, and three exist for three
 * different readers: nothing, the disk, and a language server's open documents. That last one is
 * why this is a parameter rather than a filesystem call — an editor showing errors computed from
 * the saved version of a file somebody is in the middle of changing is an editor showing
 * yesterday's errors.
 *
 * **Both members answer null rather than throwing.** The compiler's own rule is that it never
 * throws, because a language server that gets an exception cannot draw a squiggle; a host that
 * threw would put the exception back one layer down, where the caller has even less context.
 */
export interface ModuleHost {
  /**
   * A canonical id for `specifier` resolved from `from`, or null when it does not resolve.
   *
   * The id is opaque to the compiler and is only ever compared and passed back to `load`. A
   * filesystem host makes it an absolute path; a document host makes it a uri. Nothing here parses
   * one, so nothing here has an opinion about which.
   */
  resolve(specifier: string, from: string): string | null;
  /** The source at a resolved id, or null when it cannot be read. */
  load(id: string): string | null;
}

/**
 * The host for compiling one file with no project around it.
 *
 * **It resolves nothing, and that is the feature.** `CompileOptions.host` is required, so this is
 * how a caller states *there is no module graph here* rather than leaving it unsaid: a relative
 * import under this host is `DS0501` reading *this compile has no module host*, which is a
 * different sentence from *file not found* and sends a reader somewhere different. That is the same
 * distinction the linker already draws between a module this target lacks and a module no target
 * has, and it is drawn for the same reason.
 *
 * The cost is that every single-file call site has to name it, which is a line in each of them and
 * a compile error in any that forgets. What would make that wrong is a caller that wants resolution
 * and has no host to give — the language server before a workspace has loaded — which answers with
 * this one until it has, and whose coverage line then says so.
 */
export function singleFileHost(): ModuleHost {
  return {
    resolve: () => null,
    load: () => null,
  };
}
