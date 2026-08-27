# CLAUDE.md

Read [`AGENTS.md`](AGENTS.md) before changing anything. It is the contract, it is short, and every
rule in it is cited by name from somewhere in the source.

The two things most likely to be got wrong here:

**This package cannot import a host.** Not for a type, not behind an `import type`. Three tests fail
when it does and one of them explains why at length.

**A change is not verified by `npm test` alone.** `npm run build && npm test && npm run test:scripts
&& npm run typecheck` is the set. The gates in `scripts/` are where every claim that could drift is
actually held, and the size gate measures `dist/`, so it needs the build first.

Before claiming anything works, run the command and read its output. `node --test` prints failures
*above* its summary, and a pipe eats the exit code — so `npm test | tail` can report green over a
red suite.
