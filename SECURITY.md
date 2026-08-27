# Security

## Reporting

**Report privately**, through GitHub's ["Report a vulnerability"](https://github.com/drftrun/driftscript/security/advisories/new)
form on this repository. Do not open a public issue for something exploitable.

You will get an acknowledgement. This is a small project and there is no on-call rotation, so the
honest expectation is days rather than hours.

## What is in scope

**The compiler is the interesting surface, and the reason is what it is for.** DriftScript exists so
that a host can run behaviour it did not write — a modder's script, a designer's file, content that
arrived over a network. So:

- **A `.drs` file that escapes its capabilities.** A script reaching a host surface its target never
  provided, or an effect the checker did not see, is the failure this language is built to prevent.
- **A `.drs` file that makes the compiler execute something.** The compiler reads files and emits
  text; it evaluates nothing from the source it is given.
- **Generated JavaScript that does something the source did not say.** The emitter's output is the
  boundary between what an author wrote and what a host runs.
- **The language server on a hostile workspace.** It opens whatever an editor opens.

## What is not

- **A host that binds a dangerous capability.** The language checks that a script may call what it
  calls. What that call *does* belongs to the host that defined it, and no amount of checking here
  makes an unsafe binding safe.
- **A build that configures no registry and no manifest.** That configuration verifies nothing and
  says so, in the README and in this sentence. It is for a first look.
- **Denial of service by compiling something enormous.** The compiler is a build-time tool run on
  input you chose to build.

**If a script can reach a capability its target does not provide, that is a vulnerability in this
package whatever the host did.** That refusal is the promise, and it is the one worth reporting
against.

## Supported versions

The current minor. This is a young package on a single version line; there is no long-term support
branch and pretending otherwise would be a promise nobody could keep.
