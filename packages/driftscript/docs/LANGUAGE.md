# The DriftScript language reference

**This document describes what the compiler implements today**, and grows with each phase that
makes more of it true. A feature described here is a feature that compiles. A feature that is
designed and not built is not described here at all, and the design it lives in is not published.

That split is deliberate. A language reference describing unbuilt syntax is how a reader ends up
debugging their own correct program.

**Every file in [`examples/`](../examples/) is compiled by a test**, against a target that provides
no capabilities at all — `src/compiler/examples.test.ts`. An example that stops compiling fails a
suite with the compiler's own diagnostic, in the commit that broke it. Those files are the ones to
trust, and the ones to copy from.

**The fragments inside this document are not**, and that is said rather than left to be discovered.
Many are deliberately partial — a single expression, a signature with its body elided — so there is
nothing to compile. They were correct when written and are checked by eye. Where a fragment and an
example disagree, the example is right.

---

## Contents

- [Modules and prefixes](#modules-and-prefixes)
- [Values and mutability](#values-and-mutability)
- [Types](#types)
- [Expressions](#expressions)
- [Statements](#statements)
- [Records](#records)
- [Enums and match](#enums-and-match)
- [Options: there is no null](#options-there-is-no-null)
- [Results: failure is a value](#results-failure-is-a-value)
- [Integers and overflow](#integers-and-overflow)
- [Units](#units)

Sections arrive as their phase lands. The order below follows the order a reader needs them, not
the order they were built.

---

## Modules and prefixes

DriftScript has two module namespaces and the difference between them is the difference between
the language and its host.

```text
std/core   std/math   std/result   std/collections   std/time
```

**`std/*` is the language's own library.** It is available in every host, it is `pure`, and it
reads nothing — no clock, no scene, no world. A program using only `std/*` runs anywhere
DriftScript runs.

```text
drift/core   drift/time   drift/random   drift/events   drift/persistence
drift/scene  drift/audio  drift/input    drift/camera   drift/animation
```

**`drift/*` is DriftEngine's**, and every module in it carries an effect. A different host would
supply its own prefix for its own capabilities and would inherit `std/*` unchanged.

The line between them is sharper than it looks:

| | Provider | Effect |
|---|---|---|
| `std/time` | the language | `pure` — duration arithmetic, and nothing reads a clock |
| `drift/time` | the host's loop | `clock.read` — the three deltas of a running frame |
| `std/math` | the language | `pure` — `clamp`, `lerp`, the scalar functions, at either float width |
| `drift/random` | the host's generator | deterministic by construction, and the sequence is the host's |

`drift/random` is host-provided rather than standard for a specific reason: a seeded generator
whose sequence is frozen is a promise about *that host's* stored replays. A standard library that
shipped its own would either break that promise or silently become the thing that defines it.

### A module you did not provide is refused, not ignored

Importing a module declares a requirement. A target declares what it provides. A requirement the
target does not satisfy is a **link error with words in it** — it names the module, the target, and
whether the capability exists in this host at all.

A file importing an unprovided module still **parses** and still **type-checks**. Only linking
declines it. That is what lets one `.drs` file be written against a capability that has not shipped
yet, and link unchanged on the day it does.

---

## Values and mutability

```drs
let name = "door"
var alertness = 0.0
```

`let` binds immutably and cannot be reassigned. `var` can.

Immutable is the default because it serves reasoning, hot reload, task safety and deterministic
review at once — and because a compiler that can tell a mutation from a read is what makes a
system's declared reads and writes checkable later.

### `mut` is a property of a parameter, not of a type

```drs
data PulseState {
    phase: f32 = 0
}

fn update(state: mut PulseState, dt: f32) {
    state.phase += dt
}
```

`state` is declared `mut`, so its fields may be written. `dt` is not, so it may only be read.

Mutability sits on the **parameter** rather than on the type on purpose. Were `PulseState` and
`mut PulseState` different types, every signature that accepted either would double, and a
consumer's type would fork the first time somebody needed to read one and write another.

Writing through a parameter that is not `mut` is a compile error naming the parameter.

---

## Types

```text
bool
i8  i16  i32  i64
u8  u16  u32  u64
f32  f64
String
```

That is the whole primitive set. **`Vec3`, `Quat`, `Mat4`, `Transform` and `Color` are not language
types** — they arrive through a linked capability, from whatever maths the host provides. A consumer
with no renderer still has a language.

Two parameterised types are built in, `T?` and `Result<T, E>`, and both are described below. You
cannot declare your own generic type; nothing in the language needs one, and the two that exist are
about failure rather than abstraction.

A bare number literal is `f32`, because the engines this language targets compute in single
precision. A literal takes a different width when something gives it one:

```drs
let a = 1          // f32
let b: u8 = 200    // u8, and 200 fits
let c: f64 = 1     // f64
```

### Converting between them

No numeric type turns into another on its own. An integer narrowing has three spellings because it
has three intents, and a float has one because it has one:

```drs
u8.checked(v)      // u8?, absent when the value does not fit
u8.clamp(v)        // pinned to the range
u8.wrap(v)         // the low bits

f32.nearest(v)     // the nearest f32, which is what rounds an f64 down to single precision
f64.nearest(v)     // the nearest f64, which for an f32 is that value exactly
```

`nearest` is what IEEE does in both directions and there is nothing else a float conversion could
have meant, so offering `checked`, `clamp` and `wrap` here would be offering two things that do not
exist. It has to be written even when it loses nothing: the widening direction is exact, and it is
still not implicit, because a rule with an exception is a rule a reader has to keep a list for.

## Expressions

Precedence, loosest first:

```text
||
&&
==  !=
<  <=  >  >=
+  -  +%  +|  -%  -|
*  /  %  *%  *|
-x  !x
f(x)   x.field   x?.field   x?
```

```drs
2 + 3 * 4        // 14
(2 + 3) * 4      // 20
1 + 1 == 2       // true
1 < 2 && 3 < 4   // true
```

**There is no truthiness.** A condition must be `bool`. `if n { … }` on a number is an error, and
the fix is to say what you meant: `if n != 0 { … }`.

**There is no implicit widening.** `a + b` where `a` is `u8` and `b` is `u32` is an error naming the
three conversions. The compiler will not guess which one you meant.

Functions may be called before they are declared. Declaration order carries no meaning.

## Statements

```drs
let name = "door"       // immutable
var count = 0           // mutable
count = 1
count += 1

if open {
    // …
} else if ajar {
    // …
} else {
    // …
}

while count < 10 {
    count += 1
}

return value
```

A name belongs to the block it was declared in. A function that declares a return type must return
on every path — a trailing `if` without an `else` is an error, because the path where the condition
is false reaches the end.

## Records

```drs
data Door {
    open: bool = false
    angle: f32 = 0
}

fn swing(door: mut Door, by: f32) {
    door.angle += by
}
```

A record literal gives **every** field a value:

```drs
let door = Door { open: true, angle: 90deg }
```

Leaving one out is an error rather than a silent fill from the declared default. A literal that
looks complete while half of it came from somewhere else is the same ambiguity as an implicit null,
one level up. Defaults are for the generated `createDoor()`, which is a different operation with a
different name.

Records have no methods. Behaviour is a `fn` that takes the record, which is what lets the compiler
tell a read from a write — and what lets a hot reload swap a function while live instances keep
working.

**A condition never parses as a record literal.** `if door { … }` is a condition and its block. A
condition that genuinely needs a literal parenthesises it: `if (Door { open: true }).open { … }`.

## Enums and match

```drs
enum Light {
    Red
    Amber
    Green
}

enum Shape {
    Dot
    Circle(f32)
}
```

A variant may carry one value. Read them with `match`:

```drs
fn go(light: Light) -> bool {
    return match light {
        Red => false
        Amber => false
        Green => true
    }
}

fn area(shape: Shape) -> f32 {
    return match shape {
        Dot => 0
        Circle(radius) => radius * radius
    }
}
```

**A `match` must cover every variant**, and the error names the ones it missed rather than saying
"not exhaustive" — that is the answer you were about to go and look up. `_` covers the rest:

```drs
return match light {
    Green => true
    _ => false
}
```

Every arm must have the same type.

Refer to a variant by its enum's name. A payload-free variant is a value; a payload variant is
called:

```drs
let stop = Light.Red
let round = Shape.Circle(2)
```

## Options: there is no null

```drs
fn find(id: f32) -> Door? {
    // …
}
```

`T?` is an option. There is no `null` and no `undefined` in this language, so an option is the only
way to say a value might not be there — and the compiler will not let you forget it.

```drs
let maybe = some(3)      // f32?
let nothing: f32? = none
```

A bare value does **not** flow into an option position. `return 1` from a function returning `f32?`
is an error; `return some(1)` is what you meant. A language that allowed the first has reinvented
implicit null in the other direction, because a reader can no longer tell an absence that was
decided from one that was never filled in.

Read an option with `if let`:

```drs
if let door = find(3) {
    swing(door, 90deg)
} else {
    // not found
}
```

`?.` reaches through one, **and the result is still an option**:

```drs
let angle = door?.angle    // f32?, not f32
```

That is deliberate: an operation that may not have run must not be treated as though it did.

## Results: failure is a value

```drs
enum LoadError {
    Missing
    Corrupt
}

fn load(name: String) -> Result<Resource, LoadError> {
    // …
}
```

Failure is a returned value, not an exception. That matches the reliability rule the host engine
already runs on — fail fast at init, never throw in the frame loop — and a `Result` in a per-tick
path is that rule expressed as a type.

Handle it with `match`, or propagate it with `?`:

```drs
fn open(name: String) -> Result<Door, LoadError> {
    let resource = load(name)?
    return Ok(doorFrom(resource))
}
```

`?` returns the failure to the caller unchanged and continues with the value on success. It is only
legal in a function that returns a `Result` (or an option, propagating `none`), and the error types
must match.

`Ok` and `Err` take their other half from context — the binding's annotation or the function's
return type. `let a = Ok(1)` with nothing to say what the error type is, is an error rather than a
guess.

## Integers and overflow

**There is no undefined integer behaviour.** Every arithmetic operator on an integer says what it
does when the result does not fit:

```drs
a + b      // checked: fails rather than producing a value outside the type
a +% b     // wrapping
a +| b     // saturating
```

```drs
fn add(a: u8, b: u8) -> u8 {
    return a + b      // 200 + 100 fails
}

fn wrap(a: u8, b: u8) -> u8 {
    return a +% b     // 200 +% 100 is 44
}

fn clamp(a: u8, b: u8) -> u8 {
    return a +| b     // 200 +| 100 is 255
}
```

The wrapping and saturating spellings need an integer. `a +% b` on `f32` is an error rather than a
synonym for `+`, because floats neither wrap nor saturate and accepting it would teach that the
distinction is decorative.

`f32` arithmetic rounds at each operation, which is what single precision means — the same
expression gives the same answer here as in a shader.

Mixing the two float widths in one expression is refused the same way mixing two integer widths is,
and the diagnostic names `f32.nearest` or `f64.nearest` rather than the integer spellings.

## Units

```drs
let distance = 30m
let delay = 250ms
let angle = 90deg
```

**Units are erased at compile time and have no runtime representation whatsoever.** `30m` generates
the number `30`. `250ms` generates `0.25`, because seconds are the base unit. `90deg` generates
radians at the literal.

There is no wrapper, no tag, and therefore no allocation — which is what makes units usable in a
per-frame path at all. A unit that survived into generated code would cost an object per value, and
the hosts this language targets budget zero allocations there.
