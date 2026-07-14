# Strombild — language spec v0.1

A small, code-first language for describing systems as **stocks and flows** that
**run** over a time loop. The same source is the model, the runnable simulation,
and the diagram. Designed to be legible to a human at a glance and to a language
model in full.

This is a working draft. Scope is deliberately tiny: enough to express the tub,
the café, and (soon) the cell. Features are added only when a real example forces
them, never speculatively.

## Try it live

The **café** below is this very language, running. People draw people — a `hill`
inflow that reads the crowd — so the room settles either empty or packed, with a
tipping point between. Edit the source on the right and it re-runs.

<iframe src="player.html?model=cafe.strombild&play" width="100%" height="720px" frameborder="0" scrolling="no" loading="lazy" title="Strombild: the bistable café as a runnable stocks-and-flows model"></iframe>

The worked examples at the end of this spec are each a model like this one; for
now the café is the single live taste.

---

## Core idea

A model is a **graph**. Nodes are stocks (things that accumulate). Edges are
flows (things that move stuff between stocks). Every edge carries a **rate law**
that says how fast it flows. The engine walks the graph forward in time, one
small step at a time, accumulating flows into nodes. That walk is the simulation.

Two annotation channels, each optional, each with the same grammar
`marker name(params)`:

- `:` — the **definition** channel. What the thing fundamentally *is*.
  On a node: its range. On an edge: its rate law.
- `@` — the **visual** channel. How the thing is *drawn*. A stock visual
  primitive. Optional; sensible defaults apply.

You can read a model ignoring every `@` and it is complete and runnable.
You can read every `@` and you have the full rendering. They live on the same
line as the thing they describe, so they never drift out of sync.

---

## Comments

`#` begins a comment. Everything after it on the line is ignored.
Comments may be on their own line or trail a statement.

```
# this is a full-line comment
node tub : range(0, 50)   # this trails a statement
```

---

## Nodes

A **node** is a stock: a quantity that accumulates and depletes. It is tracked
in the state vector and integrated by the engine.

```
node <name> : range(<min>, <max>)  @ <visual>
```

- `: range(min, max)` — the node's bounds. The value is clamped to this range.
  Optional; if omitted, the node is unbounded.
- `@ <visual>` — the visual primitive. Optional; defaults to `bucket`.

```
node tub : range(0, 50)
node crowd : range(0, 50) @ bucket
```

---

## External nodes

An **external** node sits at the boundary of the model: a node whose internals
we have chosen *not* to model. It does not accumulate and is not tracked in the
state vector. It is treated as an infinite/given source or sink.

```
external <name>
```

Whether an external acts as a source or a sink is determined by edge direction:
an edge *leaving* it makes it a source, an edge *entering* it makes it a sink.

```
external faucet   # source: faucet -> tub
external drain    # sink:   tub -> drain
```

Externals are where inputs attach. Promoting an `external` to a `node` turns an
unmodeled boundary into a modeled, finite, feedback-capable stock — this is the
single-cell-to-population upgrade.

---

## Edges (flows)

An **edge** is a flow from one node to another. It carries a rate law on the `:`
channel and, optionally, a visual on the `@` channel.

```
<source> -> <dest> : <rate_law>(<params>)  @ <visual>
```

- `: <rate_law>(params)` — how fast stuff flows. Required.
- `@ <visual>` — how the flow is drawn. Optional; defaults to `pipe`.

```
faucet -> tub   : constant(c = 3)
tub    -> drain : proportional(of = tub, k = 0.1)
```

---

## Rate laws

A closed vocabulary of flow shapes. You pick a shape; you do not write arbitrary
code. New shapes are added to the language only when an example forces one.

Every rate law that reads a node names what it reads with `of = <node>`. This is
explicit on purpose: the meaning is visible in the source, and it handles flows
whose rate depends on a node that is neither the source nor the destination (for
example, a brake that reads a third, bystander node).

Current rate laws:

| Rate law         | Meaning                                              | Params                         |
|------------------|------------------------------------------------------|--------------------------------|
| `constant`       | A fixed rate. Reads nothing.                         | `c`                            |
| `proportional`   | Rate proportional to a node: `k * of`.               | `of`, `k`                      |
| `hill`           | Saturating/cooperative curve of a node.              | `of`, `max`, `k`, `n`          |
| `gated`          | Proportional, but throttled as the destination fills (soft backpressure). | `of`, `k`     |
| `adjust`         | Negative feedback toward a setpoint: `k * (target - of)`. May be negative.  | `of`, `target`, `k`  |
| `product`        | Two stocks multiplied: `k * of * by`. The only edge rate that reads a *second* node. | `of`, `by`, `k` |

```
constant(c = 3)
proportional(of = tub, k = 0.1)
hill(of = crowd, max = 8, k = 25, n = 4)
gated(k = 1.5)
adjust(of = inventory, target = 20, k = 1.0)
```

`hill` computes: `max * of^n / (k^n + of^n)`.

`product` is the first edge rate law to read **two** stocks — its rate is their
product, `k * of * by` (`of` defaults to the source, `by` is the second factor).
It is for a flow that is genuinely two quantities multiplied at once: cardiac output
is heart-rate × stroke-volume, so `heart -> pressure : product(of = pulse, by = volume, k)`
lets a fast loop (the pulse) and a slow one (the filling) drive one flow together —
which no single-`of` law could express. Both factors are reads, so each draws its own
influence arrow. (This is distinct from a reaction's `mass_action`, which multiplies
the reaction's *consumed* inputs; `product` multiplies two nodes and consumes neither.)

`adjust` is the control primitive: it closes a flow's loop on a *goal* instead of
a level. Positive (a top-up) when `of` is below `target`, negative (a correction)
when above — so unlike the other laws its flow can run backwards. Sum several
adjust edges into one stock and you have an anchoring-and-adjustment policy (see
`beer-game.strombild`); drop one term via a pathway and watch the loop ring.

`gated` computes `k * of * headroom`, where `headroom` is how empty the
destination is — `1` when it sits at its `range` minimum, `0` when full. So the
flow slows to a stop as its destination fills, and the queue backs up in the
*source* instead of mass leaking away at the capacity clamp. It is the first law
that reads where a flow is **going**: the destination must declare a `range`,
because that range *is* the capacity headroom is measured against. The
destination read is drawn as a (dashed) backpressure influence — the feedback
that closes the loop. This is *soft* backpressure (a smooth throttle); a hard
block that propagates a queue backward through the graph is a separate, larger
feature, deferred until a model forces it.

---

## Visuals

A closed vocabulary of **stock visual primitives**. Each primitive encodes a
*kind of state*, not just an appearance — choosing one is a claim about what the
node means. Like rate laws, the set is curated and extended only under pressure
from a real example.

Same grammar as rate laws: `name(params)`. Optional everywhere, with defaults
(`bucket` for nodes, `pipe` for edges), so you annotate only to override.

Current visuals:

| Visual    | Applies to | Represents                          | Params (illustrative)      |
|-----------|------------|-------------------------------------|----------------------------|
| `bucket`  | node       | a tapered pail that fills and drains| `fill`, `threshold`        |
| `box`     | node       | a straight-sided crate/tank         | `fill`, `threshold`        |
| `pipe`    | edge       | a flow; thickness/animation = rate  | —                          |

A node's `fill` says what the substance *is*: `water` (continuous fluid), `dots`
(loose round units — molecules, people), or `squares` (stacked square units —
discrete manufactured goods). Container shape and fill are independent: a factory's
output reads naturally as `box(fill = squares)`, raw stock as `bucket(fill = water)`.

Planned (to be added when a model forces them — not yet implemented):
`switch` (bistable on/off — now forced by the `owing` 0/1 latch in *Savings vs
debt*, which a fillable container misrepresents; for now a `box(threshold = 0.5)`
stands in, reading full/empty since the value is only ever 0 or 1), `gauge`
(graded level on a range), and others as nodes reveal that a bucket would
misrepresent them.

```
node tub : range(0, 50) @ bucket(max = 50)
faucet -> tub : constant(c = 3) @ pipe
```

---

## Influence arrows

Not every coupling in a model is a **flow**. A pipe carries mass between two
stocks. But a rate law that reads a node via `of`, and an event that tests a guard
or resets a stock, are couplings that carry *information / causation* and move no
mass. They are exactly what close every feedback loop — and they are drawn as
**dashed arrows**, visually distinct from pipes (which are solid and animated).
Solid + animated = stuff moving; dashed + still = one thing governing another.

These are **derived**, not declared — there is no new syntax. The renderer reads
them straight off the model:

| Influence | Where it comes from | Drawn |
|-----------|---------------------|-------|
| **read** (of) | an edge's `of` node, when it isn't the edge's own source | dashed arrow from that node onto the *pipe it controls* |
| **read** (guard) | an `event`'s guard node | dashed arrow into the event glyph |
| **write** | each stock an `event`'s actions assign | dashed arrow out of the event glyph (vermilion) |

The default case — a flow set by its own source (`of == src`, e.g. a tub draining
by its own level) — is *not* drawn, so diagrams aren't cluttered with the obvious;
only a read of a *third* node, or of a flow's own *destination* (positive feedback,
as in the café), earns an arrow. An `event` is drawn as a small **diamond** (a
discrete transition) labelled with its guard: reads point in, writes point out —
which is what finally connects a counter like `divisions` that no pipe touches.

---

## Pathways

A **pathway** names which edges are active for a given model or regime. The full
graph may contain more edges than any one pathway uses; a pathway lights up a
subset. Edges carry behavior; pathways carry composition.

```
pathway <name> : <edge>, <edge>, ...
```

Edges are referenced by their endpoints.

```
pathway leaky_tub : faucet->tub, tub->drain
```

### Reactions (a recipe on the pathway)

An edge is a *transport* flow: it moves stuff between two stocks and its rate law
reads at most one node (`of`). That is exactly what it cannot do for a **reaction** —
a process whose rate depends on *several* inputs at once ("needs both A and B"),
where every participant moves at one **shared** rate, in fixed proportions.

So the recipe lives on the pathway, which already scopes the whole set of
participants. A pathway carries a reaction when its body is an *equation* followed
by a rate law:

```
pathway <name> : <reactants> -> <products> : <reaction_rate_law>(<params>)
```

Reactants and products are `+`-joined terms, each optionally prefixed with a
stoichiometric coefficient (default `1`). The engine computes one rate `r` for
the whole pathway and applies `±coeff·r` to each participant: inputs go down,
outputs go up.

```
pathway assemble  : supplyA + supplyB -> factory : limiting(k = 0.5)
pathway make_gadget : 2 supplyA + supplyB -> gadget : limiting(k = 0.5)
```

Reaction rate laws (their implicit `of` is *all the reaction's inputs*):

| Rate law      | Meaning                                              | Params |
|---------------|------------------------------------------------------|--------|
| `limiting`    | The bottleneck: `k · min(input / coeff)`.            | `k`    |
| `mass_action` | Chemistry: `k · Π input^coeff`.                      | `k`    |

Selecting a reaction pathway runs that one reaction (transport edges stay live, so
supplies keep arriving). Selecting **no** pathway runs *every* reaction at once —
which is how reactions sharing a stock **compete** for it.

---

## Events

A flow can only *ooze*: every step it moves `rate · dt` of stuff, a little at a
time. Some things in a system don't ooze — they **snap**. You don't ship 0.3 of a
truck or divide 0.3 of a cell; you wait until a level crosses a line and then,
all at once, something discrete happens and *resets* state. That is an **event**,
and no rate law can express it.

```
event <name> : <guard> : <action>, <action>, ...
```

Same two-colon shape as a reaction pathway: the first `:` ends the name, the
second splits the **guard** (when it fires) from the **actions** (what it does).

- **guard** — one or more clauses `<node> <comparator> <number>` (comparators
  `>= <= > < ==`), joined with `&` and read as a **conjunction**: the event fires
  only when *every* clause holds. A single clause is the common case; the second
  clause is what gates an event on a *latch* — e.g. `& dead == 0`, so a cell that
  has died can no longer divide.
- **action** — an assignment to a stock: `<node> = <n>` (set), `<node> += <n>`
  or `<node> -= <n>` (in/decrement). Values are constants. Results clamp to the
  node's `range`.

```
event ship   : widget >= 20 : widget = 0, shipped += 20
event divide : mpf >= 30    : cyclin = 0, mpf = 0, divisions += 1
event divide : cdk >= 10 & dead == 0 : cdk = 0, divisions += 1   # gated on a latch
```

Semantics the engine holds to:

- **Edge-triggered.** An event fires on the rising edge — the substep its guard
  goes *false → true* — not every step the guard is true. So a counter ticks once
  per crossing, even if the watched stock stays high.
- **Checked every substep**, right after the flows have moved the stocks, so a
  guard catches its crossing the instant it happens (clean sawtooth teeth, no
  overshoot).
- **Armed from the initial state.** A model that *starts* above its guard does not
  fire spuriously at reset.
- **Always live** — events are part of the model's law, not a pathway regime, so
  the pathway selector doesn't gate them.

---

## Three things that trip people up

Every newcomer hits these, and they are all one idea seen from different sides: a
flow is **conserved transport of a single substance**, and that constrains what a
lone arrow can mean.

**An arrow fills its destination.** A flow subtracts from its source and adds to
its destination, every step. So a pipe `cash -> debt` does *not* pay the debt off —
it pours money *into* the debt stock and makes it bigger. To make a stock go
**down**, an arrow must point **out** of it. Whenever a quantity should shrink,
look for its outflow; the arrowhead is wherever stuff piles up.

**Two stocks that fall together need two arrows — or a reaction — not one.**
Paying a debt drops your cash *and* your debt at once, but those are opposite-signed
things (money you have vs. money you owe), and no single conserved flow can lower
two stocks. So a payment is **two outflows**: `cash -> lender` and `debt -> lender`.
The external sink (`lender`) is doing no work — it is just "outside the model," the
endpoint every flow must have; rename it `paid` and nothing changes. If you want the
two genuinely *coupled* — one act spending a dollar of cash against a dollar of debt —
that is exactly a **reaction** (`cash + debt -> settled`, see *Reactions*): it
consumes both at one shared rate and stops on its own when either runs out.

**Stopping is a rate reaching zero — there is no halt.** Nothing freezes time or
pauses a flow. In particular **an event is not a halt**: it *snaps* stock values,
then the clock keeps ticking and every flow keeps flowing. So you never "stop the
payment" — you make its rate become zero, in one of two ways. Let the flow **read
the thing it depletes** (a `proportional(of = debt)` payment fades to nothing as the
balance clears, no event needed); or have an event flip a **latch** the flow reads
(`event done : debt <= 0 : owing = 0`, with the payment `proportional(of = owing, …)`
so it zeroes when the latch does). Either way the flow switches *itself* off by what
it reads — the event only moved a number.

---

## Worked examples

### Tub — linear (the fake leak)

Both flows are constant. The outflow does not read the level, so the tub is not
yet a real ODE — just arithmetic. This is the deliberately-boring baseline.

```
# tub linear
node tub : range(0, 50)
external faucet
external drain

faucet -> tub   : constant(c = 3)
tub    -> drain : constant(c = 0.1)

pathway leaky_tub : faucet->tub, tub->drain
```

### Tub — ODE (the real leak)

One change: the outflow becomes `proportional`, reading the tub's own level.
That single keyword is the moment it becomes a real ODE — the drain now depends
on how full the tub is (water pressure).

```
# tub ode
node tub : range(0, 50)
external faucet
external drain

faucet -> tub   : constant(c = 3)
tub    -> drain : proportional(of = tub, k = 0.1)

pathway leaky_tub : faucet->tub, tub->drain
```

### Café — bistable

The inflow becomes a `hill` that reads `crowd` itself: people draw people. That
self-reference on the inflow (a flow *into* crowd whose rate reads crowd) is the
feedback loop, visible in the source. It produces two stable states — empty and
packed — with a tipping point between.

```
# cafe
node crowd : range(0, 50)
external street
external exit

street -> crowd : hill(of = crowd, max = 8, k = 25, n = 4)
crowd  -> exit  : proportional(of = crowd, k = 0.15)

pathway cafe : street->crowd, crowd->exit
```

### Factory — a reaction with a bottleneck

Two suppliers feed one factory; the recipe consumes one of each. Because the rate
is `limiting`, the line runs only as fast as the *scarcer* supplier — the slow
supplier (A) rate-limits it, and the fast one (B) piles up to capacity.

```
# factory1
node supplyA : range(0, 50), init(0)
node supplyB : range(0, 50), init(0)
node factory : range(0, 50), init(0)
external sourceA
external sourceB

sourceA -> supplyA : constant(c = 1)
sourceB -> supplyB : constant(c = 3)

pathway assemble : supplyA + supplyB -> factory : limiting(k = 0.5)
```

Give the factory a second recipe (a second pathway) and the two products compete
for the shared supplies — the next step toward CDK/cyclin, where a complex is the
active product of two species.

### Factory — the ship (an event)

factory1, unchanged, plus one line. The dock (`widget`) fills continuously, but
shipping is discrete: when the load reaches a truckful, *snap* — the dock clears
and the delivered total jumps. `widget` sawtooths; `shipped`, which nothing flows
into, staircases up. The reset is the part no edge can do.

```
# factory3
node widget  : range(0, 50),  init(0)
node shipped : range(0, 200), init(0)
node supplyA : range(0, 50),  init(0)
node supplyB : range(0, 50),  init(0)
external sourceA
external sourceB

sourceA -> supplyA : constant(c = 1)
sourceB -> supplyB : constant(c = 3)

pathway assemble : supplyA + supplyB -> widget : limiting(k = 0.5)

event ship : widget >= 20 : widget = 0, shipped += 20
```

Rename the nouns and it is the cell cycle's discrete heart: `event divide :
mpf >= 30 : cyclin = 0, mpf = 0, divisions += 1`.

### Cell cycle — the clock

The payoff of the whole language so far: **no new feature**. `constant`, `hill`,
`proportional` — the same three rate laws that made the café settle into a fixed
state — wired into a **ring** with one inversion, stop settling and start
*ticking*.

```
# cell-cycle
node cyclin : range(0, 18), init(2)  @ bucket(fill = dots)
node mpf    : range(0, 12), init(0)  @ bucket(fill = dots)
node apc    : range(0, 12), init(0)  @ bucket(fill = dots)
external ribosome
external bin
external cdk
external apc_off

ribosome -> cyclin  : constant(c = 1)
cyclin   -> bin      : proportional(of = apc, k = 0.6)        # APC destroys cyclin  ← negative arm
cdk      -> mpf      : hill(of = cyclin, max = 4, k = 12, n = 8)
mpf      -> cdk      : proportional(of = mpf, k = 0.2)
apc_off  -> apc      : hill(of = mpf, max = 4, k = 6, n = 8)
apc      -> apc_off  : proportional(of = apc, k = 0.2)
```

The loop, each arrow "drives": `cyclin →(+) mpf →(+) apc →(destroys) cyclin`.
Two pushes and one cut — net **negative feedback** around a loop with delay, which
does not rest: it oscillates. The three buckets pulse *in sequence* (cyclin, then
mpf, then apc), and as apc peaks it tears cyclin down and restarts the loop. The
travelling wave is the clock; here the period is ~32 time units, and the amplitude
is a true limit cycle (it neither grows nor decays).

The feedback couplings here are the rate laws' `of` reads (`mpf`'s inflow reads
`cyclin`, etc.), not flow edges — so they are drawn as **influence arrows** (dashed),
not pipes. That is what makes the ring visible as structure and not only as motion
(see *Influence arrows*, above).

### Cell cycle — division (the same clock, rhythm from an event)

The smooth clock got its rhythm from a third node (the APC) *continuously*
destroying cyclin. Delete the APC and let the cell actually **divide** instead: the
rhythm now comes from a discrete reset. Same biology, two sources of the same beat.

```
# cell-cycle-divide
node cyclin    : range(0, 18), init(0) @ bucket(fill = dots)
node mpf       : range(0, 8),  init(0) @ bucket(fill = dots, threshold = 6)
node divisions : range(0, 40), init(0) @ box(fill = squares)
external ribosome
external cdk

ribosome -> cyclin : constant(c = 1)
cdk      -> mpf     : hill(of = cyclin, max = 10, k = 15, n = 8)
mpf      -> cdk     : proportional(of = mpf, k = 0.5)

event divide : mpf >= 6 : cyclin = 0, mpf = 0, divisions += 1
```

Two things to see. First, **there is no flow draining cyclin** — it is removed
*only* by the divide event. The all-at-once drop is exactly what a rate law cannot
ooze. Second, the `threshold = 6` line drawn across the MPF bucket *is* the event's
guard (`mpf >= 6`): the diagram shows you the precise level that trips mitosis.
cyclin sawtooths, MPF snaps up to the line and trips it, and the divisions crate
ticks one square per cycle — a rock-steady period (~15 here).

This is the same pairing as the factory: factory3's truck and this dividing cell
are one statement — `event <name> : <level reaches a line> : reset, count += 1`.

### French flag — the fate scan (no new language, a new *reading*)

Wolpert's flag: one morphogen gradient, read against two thresholds, yields three
territories. It forces **no new keyword** — only a way to *read* an existing model.
`morphogen` is a held node (nothing flows in or out, so it sits at its level) that
is only *read* (`of = morphogen`) by two switch inflows fed from an external. The
model is single-compartment, so "position along the gradient" is just morphogen's
value — the knob, exactly as the café's `init` is its experiment.

```
node morphogen : range(0, 100), init(45)
node switchA   : range(0, 10), init(0) @ bucket(threshold = 5)   # low threshold (~30)
node switchB   : range(0, 10), init(0) @ bucket(threshold = 5)   # high threshold (~65)
external source
external sink

source -> switchA : hill(of = morphogen, max = 10, k = 30, n = 8)
source -> switchB : hill(of = morphogen, max = 10, k = 65, n = 8)
switchA -> sink   : proportional(of = switchA, k = 1)
switchB -> sink   : proportional(of = switchB, k = 1)
```

The new *analysis* is `fateScan(model, input, [readouts])`: sweep the input across
its range, settle the readouts at each level, and report each readout's on/off
**combination**. That map of combinations is the flag — blue (both off), white
(A on), red (both on) — with the impossible fourth combination (B on, A off) never
appearing, the tell that this is one ordered input, not two independent switches.

Make the switches genuinely **bistable** (café-style self-activation `hill(of =
switchX)` plus a morphogen bias) and two things appear that monotone readouts can't:
boundaries **snap sharp**, and the switches show **hysteresis** — they trip ON
higher than they trip OFF. Fate then depends on history, so a naive field
(`fateScan(…, {from:"lo"})`) and a primed field (`{from:"hi"}`) draw different
flags from the same gradient. That gap is memory.

### Savings vs debt — which way the arrows point

The example that pins down *Three things that trip people up*. Income builds cash,
interest inflates what you owe, and a fixed payment both drains your wallet and
cancels debt — until the balance is gone, when the payment should quit.

```
node cash  : range(0, 1000), init(0)  @ bucket
node debt  : range(0, 500),  init(50) @ bucket
node owing : range(0, 1),    init(1)  @ box(threshold = 0.5)   # a 0/1 latch: full+amber while owing, empty when paid
external income
external interest
external lender

income   -> cash   : constant(c = 2)                     # take-home
cash     -> lender : proportional(of = owing, k = 1.2)   # the payment leaves your wallet…
interest -> debt   : proportional(of = debt, k = 0.018)  # 22% APR, compounding monthly
debt     -> lender : proportional(of = owing, k = 1.2)   # …and cancels that much debt

event done : debt <= 0 : owing = 0                       # balance cleared → stop paying

pathway payoff : income->cash, cash->lender, interest->debt, debt->lender
```

All three traps are visible at once: debt is **drained** (`debt -> lender`), never
filled; the payment is **two outflows** to the `lender` sink because cash and debt
fall together; and the `done` event flips the `owing` **latch** so the payments —
which read it — switch off at a zero balance instead of bleeding cash into a debt
that no longer exists. (Read the payment off `of = debt` instead of a latch and it
stops *itself*, no event required — the reaction-style version.)

Two practical notes this model answers:

- **Turning a real percentage into a `k`.** `proportional` compounds *continuously*,
  so after one tick a balance multiplies by `e^k`, not `1 + k`. To land an exact rate
  `r` per tick, use `k = ln(1 + r)`. A 22% APR on a monthly tick is `22%/12 ≈ 1.83%`
  a month → `k = ln(1.0183) ≈ 0.018`.
- **It is the café switch again.** With a flat payment `P` against interest rate `k`,
  the debt has an *unstable* fixed point at `P/k` (~67 here): start below it and you
  pay off, above it and interest outruns the payment and you spiral — the debt trap.
  `knifeEdge(model, "debt")` finds that line, and flipping `init` across it flips the
  fate, exactly as the café's `init` does.

---

## How it runs (engine sketch)

Each step of the time loop:

1. For every `node`, sum the flows in (edges pointing at it) minus flows out
   (edges leaving it), each evaluated from its rate law and the current state.
   Then add each active reaction: compute its one shared rate and apply `±coeff·r`
   to every participant (inputs down, outputs up).
2. That sum is the node's rate of change. Nudge: `node += rate * dt`.
3. Clamp each node to its `range`.
4. Fire events: for each `event`, test its guard; on a false→true crossing apply
   its actions (the discrete resets), clamped to range.
5. `external` nodes are skipped — they supply or absorb but do not accumulate.
6. Repeat.

Cycles in the graph (a flow whose rate reads a node it feeds, directly or
through a loop) are the feedback loops; they are what require step-by-step
integration rather than one-pass evaluation.

---

## Not yet in the language (deferred until an example forces it)

- **Time-varying inputs** on externals — the "dataset / busy-morning vs
  quiet-afternoon" scenario, which points at a model-vs-scenario split. Now the
  leading gap: every external is presently a constant boundary.
- **Orbit / fate detection** — classifying whether a trajectory rests, loops, or
  is latched. First piece landed: `fateScan` reads the latched on/off *combination*
  of a set of stocks as one input is swept (the French flag), with `{from:"lo"|"hi"}`
  tracing the two branches of a bistable switch's hysteresis. Still deferred: seeing
  an **oscillation** (the cell-cycle limit cycle), which a settle-and-read scan can't.
- **Multiple swappable visual views** of one model — only if the teaching tool
  wants "see the same model as buckets or as a phase portrait."
- Additional rate laws and visual primitives, added one at a time as real models
  demand them.
```
