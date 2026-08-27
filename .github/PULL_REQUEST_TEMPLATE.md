## What changes, and why

<!-- The why is the part the diff cannot say. What was tried first, what the alternative cost, and
     what would make this the wrong answer later. -->

## How it is held

<!-- A claim that can drift is asserted somewhere that fails. Which test fails without this change?
     A refactor has no answer here, and saying so is the answer. -->

## Checks

- [ ] `npm run build && npm test && npm run test:scripts && npm run typecheck`
- [ ] A behaviour change has a test that fails without it
- [ ] No new dependency in `driftscript` — `npm ls driftscript` still shows one package
- [ ] No diagnostic code renumbered
- [ ] A document this change makes wrong is corrected in the same commit
