/**
 * `std/core`, and the reason this file has no engine import in it.
 *
 * `std/*` is provided by the language in every host and is `pure` — R9 of the design. A second
 * host has no scene graph and no fixed-step loop, so anything here that reached for one would be
 * a library that is standard only in this repository. The cost is that genuinely useful engine
 * things live one prefix away in `drift/*` and a script author types the difference; what would
 * make it wrong is a host that turns out to need no capabilities at all, which no host does.
 */

/**
 * The identity function.
 *
 * It is here because a package needs one exported symbol before anything can prove it resolves,
 * and because `std/core` will grow around it. It is not a placeholder: `identity` is the
 * canonical no-op for a pipeline stage a consumer wants to disable, and every standard library
 * that omits it grows one under a worse name.
 */
export function identity<T>(value: T): T {
  return value;
}
