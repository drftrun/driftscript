# DS-8 — networking, replication and rollback semantics

**Status: answered, 1.13.0, 2026-09-03.** DS-8 was the last refused DriftScript phase and it waited
on Track J, the one track that unblocked language work. Track J shipped, and this is what DS-8 turned
out to be: three questions, two of which were already answered by decisions made years earlier in
this design, and one small piece of new checking.

`§22` of the design specified the surface before any host could provide it, on the argument that
replication constrains state identity, serialization, authority, task semantics and RNG — and that
designing those five without knowing what networking wants is how a language acquires a redesign.
That argument held up. What follows is what each of those five turned out to need.

---

## 1. The fixed clock already survives a rewind

`runtime/clocks.ts` carried the open question in its own header: *"what would make the whole shape
wrong is a host whose fixed clock can go backwards, which is what rollback netcode does when it
resimulates: a deadline cannot express 'resume at step N' across a rewind."*

**It can, and it always could.** The fixed clock is a *step count* rather than seconds, so
`deadlineAfter('fixed', …)` returns an absolute step number and the scheduler compares it against
`fixedSteps()`. An absolute number means the same thing after the clock moves in either direction: a
task waiting for step 500 is still waiting for step 500 after a rewind to 483, and reaches it on the
replayed step 500.

What the deferral was protecting against is a deadline held as a *remaining duration*, which would be
re-measured from wherever the clock happened to be and would slip by the whole rewind every time.
Nothing here holds one. **The decision that made this work was made in DS-3**, when the fixed clock
was given steps as its unit for a reason about replay, and it paid for itself in a phase written
five phases later.

`clocks.test.ts` drives a host backwards by hand and asserts both halves. The header is corrected.

## 2. `@replicated` is checked

It has been a lexer token since `§22` and read by nothing. It now means: **this component field is
one a host publishes**, and the compiler asserts two things about it.

- **It belongs to a `component`.** A `data` record is a value a function passes around; a component
  is state an entity carries, which is what another peer needs a copy of. A record marked replicated
  describes a thing with no identity to replicate *to*.
- **It holds a number.** A replication path carries scalars, because anything richer needs a schema
  on the wire and a schema on the wire is a versioning problem rather than a networking one. An
  optional is refused too: it needs a presence bit beside the value, and a packet has no column for
  one.

`Entity` is permitted and carries a caveat rather than a refusal. A handle is a number, so it
crosses; whether it *means* the same thing at the other end depends on the host's model. Two lockstep
peers build the same world and their handles agree; an authoritative host and its client do not. The
compiler cannot tell which host it is being compiled for, so it permits the field and
`check/network.ts` is where the caveat lives.

**It registers nothing**, which is the property the whole capability model rests on: a file marking
fields replicated links against a target providing no networking at all and behaves exactly as it
did.

## 3. `network.write` stays outside the deterministic effects, and now for a reason

`registry/capability.ts` had left it out with a note that the exclusion was *"a deferral rather than
a judgement: the track that builds one is the one that can say whether its writes are the simulation
or a consequence of it."*

Track J's answer: **it stays outside, and the reason is the rewind loop rather than the send.** The
tempting argument for admitting it is that publishing a value changes no simulation state, so a
replay would publish the same thing and nothing would drift. That is backwards once rollback exists —
a `@deterministic` function is precisely the kind that gets re-run, and a send is not idempotent. A
correction replaying twelve ticks would put twelve duplicate messages on the wire.

`network.read` stays inside, narrowed: only the parts of a session that cannot vary with packet
timing. Which participant this is, and whether it is the authority. A confirmed-input watermark is
not one of those.

---

## What `§22` sketched and this does not build

`§22` showed six annotations. One is built, and the other five are refused in writing here rather
than half-built, which is what this project does with a scope it has not earned.

| Sketched | Status |
|---|---|
| `@replicated` | **Built.** §2 above |
| `@ownerOnly` | **Refused for now.** It is a field assertion of the same kind as `@replicated` and would cost little — but it asserts something about *authority*, and authority is a host's model rather than a language's. A lockstep session has no owner at all. *Reversed by* a second host with an owner concept, so the annotation describes something two implementations agree on |
| `@interpolated` | **Refused for now.** It says how a value should be *drawn* between two states, which is presentation. `StateInterpolator` is a host's, and a language that named interpolation would be naming a rendering policy. *Reversed by* a host wanting the compiler to refuse an interpolated field of a type that cannot be blended — an enum, a handle — which is a real check and a small one |
| `@server` / `@client` | **Refused.** These partition a program by where it runs, which is a compilation-target question and much larger than an annotation: it needs two outputs from one source, a rule for what may call across the line, and a story for what a shared function is. *Reversed by* a consumer shipping two builds from one source and maintaining the split by hand, which is the measurement that would justify building it |
| `@rollback` on a `data` record | **Refused.** It marked a record as one a rewind restores. A host's rewind restores *state*, and which state is the host's decision — DriftEngine's `Snapshotter` is generic over its own slot type for exactly that reason. An annotation here would let a script claim membership of a set the host owns |

## What is left, and it is one row

**A rewind does not restore the scheduler.** `runtime/tasks.ts` holds its task list in module state:
which tasks are live, where each is suspended, and each frame's locals. A host that rewinds restores
its world and its generator and leaves that alone, so a task that completed between two ticks stays
completed after a rewind past it.

**The layout it would need already exists.** `emit/task.ts`'s `frameLayout` enumerates every slot a
task's frame carries with the type it holds, because a hot patch needs exactly that — and every task
local is rewritten into a frame read or write rather than living in a closure. So this is a piece of
work rather than a redesign, and the shape is: capture the frame's slots and the scope association,
restore them, and say plainly that a *record* held in a task local is shared rather than copied.

It is not built here because DS-8 was scoped to the three questions above and because no consumer has
asked: DriftEngine's Track J rewinds a world and a generator, and its scripts' tasks are not yet
inside the rewound region. **Reversed by** a consumer whose rolled-back simulation drives tasks.
