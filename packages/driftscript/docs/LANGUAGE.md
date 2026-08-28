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
std/core   std/math   std/result   std/time
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
target does not satisfy is a **link error with words in it**, and there are three of them:

- **This host describes it** — the registry has capabilities for it and the manifest did not ask.
  Add it to the manifest.
- **The module is specified and your file is valid** — a surface the language designed that nothing
  here implements yet. Your file is fine and links when a host builds it.
- **Not a module this language specifies** — a misspelling, and the refusal names the near one.

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

Three parameterised types are built in — `T?`, `Result<T, E>` and `List<T>` — and all three are
described below. You cannot declare your own generic type.

### Lists

```drs
let names = ["clear", "cloud", "rain", "storm"]
let n = len(names)          // u32
let third = names[2]        // "rain", and an index past the end throws

var queue: List<f32> = []
push(queue, 1)

for name in names {
    // …
}
```

`[a, b]`, `xs[i]`, `len`, `push` and `for … in` are **language forms rather than a module**, which
is why there is no `std/collections` — a capability's parameter types are names in a data format a
host writes, and a module function over `List<T>` would need a type variable there.

**An index past the end throws**, for the reason integer overflow does: JavaScript's own answer is
`undefined`, which a script has no type for, and it would surface as a `NaN` frames later somewhere
else.

**`push` needs a `mut` binding**, because growing a list is writing to the container — the same rule
a record field follows.

**A list is invariant.** A `List<Wolf>` is not a `List<Dog>` even though a `Wolf` is a `Dog`. With
covariance a `Dog` could be pushed through a reference whose real list holds `Wolf`, and record
subtyping is sound here partly because that cannot happen.

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

### Module constants

A `let` at the top of a file is a constant the whole file can name, and another file can import:

```drs
let MINUTE = 60
let SECONDS_PER_HOUR = 60 * MINUTE
let LABEL = "hour"
```

Its value is a number, a string, a `bool`, arithmetic over those, or another constant. **A call is
not allowed**: a module is evaluated before its host is bound, so there would be nothing to call.

Declaration order carries no meaning here either — `SECONDS_PER_HOUR` above may be written before
`MINUTE`, and a cycle between two constants is an error naming both.

**`var` is refused at this level.** Module-level mutable state is state a hot reload has to migrate,
a replay has to restore, and two systems can race on. A constant has none of those problems.

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

`break` leaves the innermost loop and `continue` skips to its next turn. There are no labels, so a
jump always means the loop it is written in:

```drs
for e in query<Hunger>() {
    if e.Hunger.value <= 0 {
        continue
    }
    if e.Hunger.value > 100 {
        break
    }
    e.Hunger.value = e.Hunger.value - 1
}
```

**`break` out of a query loop finishes walking the cursor before it leaves.** A query's cursor comes
from a pool and is given back when the walk is exhausted, so leaving early has to reach that point
anyway — the remaining entities are stepped over without the body running. It costs a step per
remaining entity and it is what keeps `break` from leaking a cursor per frame.

### Reaching a component through a handle

`e.Component.field` works on any entity handle, not only on one a query loop bound:

```drs
fn bump(world: World, who: Entity) -> f64 {
    who.Placement.x = who.Placement.x + 1
    return who.Placement.x
}
```

Inside a query loop this is a view and an index. Outside one it compiles to `ecs.read` and
`ecs.write` — the same calls you would otherwise write by hand with the component and field as
strings, except that here both names are checked: a misspelled field is an error at the line that
wrote it rather than a zero at runtime.

**It needs a world in scope**, because that is what the read runs against. A `system` has one; a
function takes a `World` parameter.

A function can say which component it works on, and take a row of it:

```drs
fn advance(m: mut Placement, dx: f64) {
    m.x = m.x + dx
}

for e in query<Placement>() {
    advance(e.Placement, 1)
}
```

The argument is always `entity.Component`, because that is where the handle comes from. `mut` means
the helper may write, and the component it names is what the caller's system is checked to have
declared — the signature is where a reader and the inference both learn it.

**A component is not a value.** Its fields are columns in a world, so there is no object to bind a
name to: `let m = e.Placement` and returning one are both errors. Read a field from it, or pass it to a
function that takes a row.

### A component you query is a component you declare

A system's `reads` and `writes` are an assertion about what its body touches, and **naming a
component in a query counts**: a host is handed every component the query narrows by, and a host
that derives its schedule from these declarations refuses a query naming one the system did not
declare.

```drs
system Walk {
    reads Gait
    writes Placement

    update {
        for e in query<Gait, Placement>().without<Still>() {
            e.Placement.x = e.Placement.x + 1
        }
    }
}
```

`Gait` is declared although no field of it is read: the loop narrows by it, so the host is told about
it. `Still` is not declared, and must not be — an exclusion never looks inside the component, and an
entity it matched is not in the result at all. `.with<T>()` narrows the same way the type arguments
do, so it counts like them.

**This was wrong in this compiler until 2026-08-28**, and it was wrong in the direction that costs
most: the analysis walked a loop's body and not its terms, so `DS0291` called the declaration a host
demanded unused, and a module written on that advice compiled clean and threw once a tick inside the
host's schedule. Reported from outside by somebody who found it from play, as a *different* system
stuttering. `DS0288` refuses the omission now, which is where a compiler should meet it.

### What a system is handed

A system takes no arguments, so `uses` is how it receives anything the host owns:

```drs
system Walk {
    uses graph: NavGraph
    writes Placement

    update {
        for e in query<Placement>() {
            let path = navigation.pathOf(graph, e)
            e.Placement.speed = navigation.remaining(path)
        }
    }
}
```

`NavGraph` is a type a host registered, like any other handle a capability takes. The clause binds
it under a name for the body, and the name is immutable: the host owns the value, and a script
passes it back to a capability rather than looking inside it.

**A resource is one per type, and the type is what the host is asked for.** Two systems naming the
same type differently are handed the same object, and renaming a binding changes nothing outside the
file it is in. Two clauses of one type in one system are an error for the same reason — they were
always two names for one thing.

**Why this exists.** Without it a handle reaches a script only as a function parameter, so anything
per-entity has to be driven from outside: the host walks the entities and calls a function once each,
and the loop leaves the schedule, the declared-access checks, and any chance of staying in step with
the query it replaced. A component field holding a handle would be the other way to close that, and
it is refused: a component is what a save file holds, and a host's object has no stable id, no
constant a prefab could give it, and nothing for a scene load to rewrite.

A handle **per entity** comes from a capability, since one may return a host type:
`navigation.pathOf(graph, e)` above is the whole pattern — the host keeps the table, the script
keeps the rule.

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
