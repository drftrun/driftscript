/**
 * Copy the generated grammar into the extension, at package time.
 *
 * **The grammar is generated from the compiler's token table and is never committed twice.** A
 * second checked-in copy is a second definition of the language, and it goes stale on the Friday
 * somebody adds a keyword — silently, while reporting correctly on what it had looked at, which is
 * the failure the tooling design's §2 names. So `syntaxes/` is ignored by git and filled by this.
 *
 * It reads the generated file rather than regenerating: `npm run grammar:check` is what fails when
 * that file is stale, and having two things able to produce it would be the duplication this exists
 * to prevent.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const GENERATED = path.join(
  HERE,
  '..',
  '..',
  '..',
  'packages',
  'driftscript',
  'src',
  'tooling',
  'grammar',
  'generated',
  'driftscript.tmLanguage.json',
);

export const DESTINATION = path.join(HERE, '..', 'syntaxes', 'driftscript.tmLanguage.json');

export function copyGrammar() {
  mkdirSync(path.dirname(DESTINATION), { recursive: true });
  copyFileSync(GENERATED, DESTINATION);
  return DESTINATION;
}

/* Only when run, never when imported. The guard exists so a test can read the two paths above
   without writing a file as a side effect of asking where the file goes. */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  copyGrammar();
  process.stdout.write(`copied ${path.relative(process.cwd(), GENERATED)} -> syntaxes/\n`);
}
