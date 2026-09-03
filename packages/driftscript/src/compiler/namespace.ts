/** The name a module's capabilities are reached through, and whether it can be written at all. */

/**
 * The namespace an import gets when it names none: the last segment of the specifier.
 *
 * One definition, because there were three — the checker's, the lowering's and the one the hot-path
 * pass builds its capability table from — and three copies of a derivation is three places for a
 * rule to change in two of them.
 */
export function namespaceOf(specifier: string): string {
  return specifier.split('/').pop() ?? specifier;
}

/**
 * Whether a name can be written in this language.
 *
 * Deliberately the plain identifier rule rather than the lexer's, which also accepts a soft keyword
 * in an identifier position. A namespace that was a soft keyword would read as one thing and mean
 * another at the point somebody adds a form that uses it, and this is a name an author is choosing
 * rather than one they are stuck with.
 */
export function isIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * A name to suggest when a specifier's own segment will not do.
 *
 * Not a general sanitiser, and not used for anything but a diagnostic's suggestion — the language
 * never picks a namespace on the author's behalf. It strips what cannot appear and puts a letter in
 * front of a leading digit, so `drift/2d` suggests `d2d`: ugly enough that somebody will write a
 * better one, and valid enough to paste.
 */
export function suggestedAlias(specifier: string): string {
  const stripped = namespaceOf(specifier).replace(/[^A-Za-z0-9_]/g, '');
  if (stripped === '') return 'module';
  return /^[0-9]/.test(stripped) ? `d${stripped}` : stripped;
}
