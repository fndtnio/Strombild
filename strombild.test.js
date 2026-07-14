/* =====================================================================
 * STROMBILD core tests — run with:  node --test
 * Pure language core only (no DOM). Guards parser + engine behaviour so
 * we notice when adding CDK / events / inputs breaks something earlier.
 * ===================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const S = require("./strombild.js");

const DIR = path.join(__dirname, "examples");   // the .strombild examples live here
const ok = src => {
  const r = S.parseModel(src);
  assert.deepEqual(r.errors, [], "expected no parse errors:\n" + JSON.stringify(r.errors, null, 2));
  return r;
};
// run a model to (near) steady state and read a stock
function settle(src, node, { t = 400, pathway = null, seed } = {}) {
  const { model } = ok(src);
  const eng = new S.Engine(model);
  if (pathway) eng.setPathway(pathway);
  if (seed) for (const [k, v] of Object.entries(seed)) eng.state.set(k, v);
  eng.advance(t);
  return eng.state.get(node);
}
const near = (a, b, eps = 0.1) => Math.abs(a - b) <= eps;

/* ---------------- parser ---------------- */

test("parses a clean model: counts and shapes", () => {
  const { model } = ok(`
    node tub : range(0, 50)
    external faucet
    external drain
    faucet -> tub  : constant(c = 3)
    tub -> drain   : proportional(k = 0.1)
    pathway leaky_tub : faucet->tub, tub->drain
  `);
  assert.equal(model.nodes.size, 1);
  assert.equal(model.externals.size, 2);
  assert.equal(model.edges.length, 2);
  assert.equal(model.pathways.size, 1);
  assert.deepEqual(model.nodes.get("tub").range, [0, 50]);
});

test("comments and blank lines are ignored", () => {
  const { model } = ok(`
    # a comment line
    node tub : range(0, 50)   # trailing comment
    external faucet
    faucet -> tub : constant(c = 3)  # inline
  `);
  assert.equal(model.nodes.size, 1);
  assert.equal(model.edges.length, 1);
});

test("undeclared edge endpoint becomes an implicit external (warning, not error)", () => {
  const r = S.parseModel(`
    node tub : range(0, 50)
    faucet -> tub  : constant(c = 3)
    tub -> drain   : constant(c = 0.1)
  `);
  assert.deepEqual(r.errors, []);
  assert.equal(r.model.externals.get("faucet").role, "source");
  assert.equal(r.model.externals.get("drain").role, "sink");
  assert.ok(r.warnings.some(w => /faucet/.test(w.msg) && /never declared/.test(w.msg)));
});

test("unknown rate law and missing params are errors", () => {
  const r1 = S.parseModel(`node a\n a -> b : wobble(x = 1)`);
  assert.ok(r1.errors.some(e => /unknown rate law/.test(e.msg)));
  const r2 = S.parseModel(`node a\n a -> b : hill(of = a, max = 8, k = 25)`); // missing n
  assert.ok(r2.errors.some(e => /missing param "n"/.test(e.msg)));
});

test("edge without a rate law is an error", () => {
  const r = S.parseModel(`node a\n a -> b`);
  assert.ok(r.errors.some(e => /no rate law/.test(e.msg)));
});

test("range(0,50)'s internal comma does not confuse the channel splitter", () => {
  const { channels } = S.splitChannels("node crowd : range(0, 50) @ bucket(fill = dots)");
  assert.equal(channels[":"], "range(0, 50)");
  assert.equal(channels["@"], "bucket(fill = dots)");
});

/* ---------------- init (new) ---------------- */

test("init parses on the definition channel alongside range", () => {
  const { model } = ok(`node crowd : range(0, 50), init(30) @ bucket(fill = dots)`);
  const n = model.nodes.get("crowd");
  assert.deepEqual(n.range, [0, 50]);
  assert.equal(n.init, 30);
  assert.equal(n.fill, "dots");
});

test("init order is free and works without range", () => {
  const a = ok(`node x : init(7), range(0, 100)`).model.nodes.get("x");
  assert.equal(a.init, 7);
  assert.deepEqual(a.range, [0, 100]);
  const b = ok(`node y : init(5)`).model.nodes.get("y");
  assert.equal(b.init, 5);
  assert.equal(b.range, null);
});

test("engine starts a stock at its init, default = range min", () => {
  const m1 = ok(`node crowd : range(0, 50), init(30)`).model;
  assert.equal(new S.Engine(m1).state.get("crowd"), 30);
  const m2 = ok(`node crowd : range(5, 50)`).model;        // no init -> range min
  assert.equal(new S.Engine(m2).state.get("crowd"), 5);
});

test("init outside range warns and is clamped at reset", () => {
  const r = S.parseModel(`node crowd : range(0, 50), init(80)`);
  assert.ok(r.warnings.some(w => /outside range/.test(w.msg)));
  assert.equal(new S.Engine(r.model).state.get("crowd"), 50);
});

/* ---------------- engine numerics ---------------- */

test("tub ODE settles at inflow/drain = 30", () => {
  assert.ok(near(settle(`
    node tub : range(0, 50)
    faucet -> tub : constant(c = 3)
    tub -> drain  : proportional(k = 0.1)
  `, "tub"), 30, 0.05));
});

test("'of' defaults to the edge source", () => {
  // drain reads tub (the source) even though 'of' is omitted
  const { model } = ok(`node tub : range(0, 50), init(20)\n tub -> drain : proportional(k = 0.1)`);
  const eng = new S.Engine(model);
  eng.derivatives();
  assert.equal(eng.lastFlows.get("tub->drain"), 0.1 * 20);
});

test("linear tub (constant out) overflows and clamps at capacity", () => {
  assert.equal(settle(`
    node tub : range(0, 50)
    faucet -> tub : constant(c = 3)
    tub -> drain  : constant(c = 0.1)
  `, "tub", { t: 100 }), 50);
});

test("café is bistable: init selects the fate", () => {
  const cafe = init => `
    node crowd : range(0, 50), init(${init})
    street -> crowd : hill(of = crowd, max = 8, k = 25, n = 4)
    crowd  -> exit  : proportional(of = crowd, k = 0.15)`;
  assert.ok(near(settle(cafe(30), "crowd"), 50, 0.5), "init 30 -> packed");
  assert.ok(near(settle(cafe(10), "crowd"), 0, 0.5),  "init 10 -> empty");
});

test("the cell-cycle ring sustains a limit cycle (3-node negative feedback)", () => {
  // built only from constant/hill/proportional — no new rate law. it must
  // oscillate, and the oscillation must NOT decay (a true limit cycle).
  const src = `
    node cyclin : range(0, 18), init(2)
    node mpf    : range(0, 12), init(0)
    node apc    : range(0, 12), init(0)
    ribosome -> cyclin : constant(c = 1)
    cyclin   -> bin     : proportional(of = apc, k = 0.6)
    cdk      -> mpf     : hill(of = cyclin, max = 4, k = 12, n = 8)
    mpf      -> cdk     : proportional(of = mpf, k = 0.2)
    apc_off  -> apc     : hill(of = mpf, max = 4, k = 6, n = 8)
    apc      -> apc_off : proportional(of = apc, k = 0.2)`;
  const { model } = ok(src);
  const eng = new S.Engine(model);
  const C = [];
  for (let i = 0; i < 2400; i++) { eng.advance(0.5); C.push(eng.state.get("cyclin")); }
  const amp = a => Math.max(...a) - Math.min(...a);
  const early = amp(C.slice(300, 700));     // ~t150-350
  const late  = amp(C.slice(2000, 2400));   // ~t1000-1200
  assert.ok(early > 3, `should oscillate, early amplitude ${early.toFixed(2)}`);
  assert.ok(near(early, late, 0.5), `limit cycle (no decay): early ${early.toFixed(2)} vs late ${late.toFixed(2)}`);
  // peaks in cyclin -> it really cycles, not just drifts
  const back = C.slice(1200);
  let peaks = 0;
  for (let i = 1; i < back.length - 1; i++)
    if (back[i] > back[i-1] && back[i] >= back[i+1] && back[i] - Math.min(...back) > 1) peaks++;
  assert.ok(peaks >= 5, `expected several cycles, got ${peaks} peaks`);
});

test("event-driven cell cycle: regular division sawtooth from the reset", () => {
  // no flow drains cyclin — only the divide event does. so a steady cyclin build
  // + threshold reset must give a regular, repeating cycle.
  const src = `
    node cyclin    : range(0, 18), init(0)
    node mpf       : range(0, 8),  init(0)
    node divisions : range(0, 40), init(0)
    ribosome -> cyclin : constant(c = 1)
    cdk      -> mpf     : hill(of = cyclin, max = 10, k = 15, n = 8)
    mpf      -> cdk     : proportional(of = mpf, k = 0.5)
    event divide : mpf >= 6 : cyclin = 0, mpf = 0, divisions += 1`;
  const { model } = ok(src);
  const eng = new S.Engine(model);
  let prevD = 0, t = 0; const fireT = [];
  for (let i = 0; i < 1000; i++) {
    eng.advance(0.2); t += 0.2;
    const d = eng.state.get("divisions");
    if (d > prevD) { fireT.push(t); prevD = d; }
  }
  assert.ok(prevD >= 8, `cell should divide repeatedly, got ${prevD} divisions`);
  assert.equal(eng.eventFires.get("divide"), prevD, "cumulative fire count matches the counter");
  // every cyclin sawtooth resets, so it never climbs to the ceiling
  assert.ok(eng.state.get("cyclin") < 18, "cyclin sawtooths, never pinned at capacity");
  // periods are regular: spread across cycles is small
  const per = fireT.slice(1).map((x, i) => x - fireT[i]);
  const avg = per.reduce((a, c) => a + c, 0) / per.length;
  assert.ok(per.every(p => Math.abs(p - avg) < 1), `regular period ~${avg.toFixed(1)}`);
});

test("stocks never leave their range under integration", () => {
  const { model } = ok(`
    node tub : range(0, 50)
    faucet -> tub : constant(c = 100)
    tub -> drain  : proportional(k = 0.01)`);
  const eng = new S.Engine(model);
  for (let i = 0; i < 500; i++) {
    eng.advance(1);
    const v = eng.state.get("tub");
    assert.ok(v >= 0 && v <= 50, `tub left range: ${v}`);
  }
});

/* ---------------- soft backpressure (gated) ---------------- */

test("gated flow is throttled by the destination's headroom", () => {
  const { model } = ok(`
    node src  : range(0, 100), init(40)
    node tank : range(0, 10),  init(0)
    src -> tank : gated(k = 2)`);
  const eng = new S.Engine(model);
  eng.derivatives();
  assert.equal(eng.lastFlows.get("src->tank"), 80);   // tank empty -> full speed: 2*40
  eng.state.set("tank", 10); eng.derivatives();
  assert.equal(eng.lastFlows.get("src->tank"), 0);    // tank full -> backpressure shuts the flow
  eng.state.set("tank", 5);  eng.derivatives();
  assert.equal(eng.lastFlows.get("src->tank"), 40);   // half full -> half speed
});

test("gated requires its destination to declare a capacity (range)", () => {
  const noRange = S.parseModel(`
    node src  : range(0, 100), init(40)
    node tank : init(0)
    src -> tank : gated(k = 1)`);
  assert.ok(noRange.errors.some(e => /backpressure needs a capacity/.test(e.msg)));
  const external = S.parseModel(`
    node src : range(0, 100), init(40)
    src -> sea : gated(k = 1)`);   // sea is an implicit external, no capacity
  assert.ok(external.errors.some(e => /backpressure needs a capacity/.test(e.msg)));
});

test("soft backpressure backs the queue up instead of overfilling downstream", () => {
  // arrivals (5) outpace max clearing (0.3*12 = 3.6): the strait jams near its
  // ceiling and the overflow waits in the port — conserved, not leaked at a clamp.
  const { model } = ok(`
    node port   : range(0, 1000), init(0)
    node strait : range(0, 12),   init(0)
    ocean  -> port   : constant(c = 5)
    port   -> strait : gated(k = 1.5)
    strait -> sea    : proportional(k = 0.3)`);
  const eng = new S.Engine(model);
  eng.advance(200);
  const strait = eng.state.get("strait"), port = eng.state.get("port");
  assert.ok(strait > 10 && strait <= 12, `strait congested near capacity, got ${strait}`);
  assert.ok(port > 100, `ships back up in the port, got ${port}`);
});

test("gated's destination read is an influence flagged as backpressure", () => {
  const { model } = ok(`
    node port   : range(0, 400), init(0)
    node strait : range(0, 12),  init(0)
    feed   -> port   : constant(c = 2)
    port   -> strait : gated(k = 1.5)`);
  const inf = S.influences(model);
  // gated's `of` defaults to its source (port) so no third-party read; the only
  // influence is the destination-headroom read that closes the backpressure loop.
  assert.equal(inf.length, 1);
  assert.deepEqual(inf[0], { kind: "read", from: "strait", to: { edge: "port->strait" }, backpressure: true });
});

/* ---------------- adjust (setpoint feedback) + bullwhip ---------------- */

test("adjust drives toward a setpoint: k*(target - of), signed", () => {
  const { model } = ok(`
    node x : range(0, 100), init(0)
    src -> x : adjust(of = x, target = 30, k = 2)`);
  const eng = new S.Engine(model);
  eng.state.set("x", 10); eng.derivatives();
  assert.equal(eng.lastFlows.get("src->x"), 2 * (30 - 10));   // below target -> +40 (top up)
  eng.state.set("x", 30); eng.derivatives();
  assert.equal(eng.lastFlows.get("src->x"), 0);               // at target -> nothing to do
  eng.state.set("x", 50); eng.derivatives();
  assert.equal(eng.lastFlows.get("src->x"), 2 * (30 - 50));   // above target -> -40 (a correction)
});

test("adjust requires a target", () => {
  const r = S.parseModel(`node x : range(0,50)\n src -> x : adjust(of = x, k = 1)`);
  assert.ok(r.errors.some(e => /missing param "target"/.test(e.msg)));
});

/* ---------------- product (a flow's rate = two stocks multiplied) ---------------- */

test("product multiplies two nodes: rate = k * of * by", () => {
  const { model } = ok(`
    node pressure : range(0, 300), init(0)
    node pulse    : range(0, 200), init(0)
    node volume   : range(0, 200), init(0)
    heart -> pressure : product(of = pulse, by = volume, k = 0.01)`);
  const eng = new S.Engine(model);
  eng.state.set("pulse", 70); eng.state.set("volume", 50); eng.derivatives();
  assert.equal(eng.lastFlows.get("heart->pressure"), 0.01 * 70 * 50);   // 35
  eng.state.set("volume", 0); eng.derivatives();
  assert.equal(eng.lastFlows.get("heart->pressure"), 0);               // either factor zero -> no flow
});

test("product requires 'by' and 'k'", () => {
  assert.ok(S.parseModel(`node x:range(0,9)\n a -> x : product(k = 1)`).errors.some(e => /missing param "by"/.test(e.msg)));
  assert.ok(S.parseModel(`node x:range(0,9)\n a -> x : product(by = x)`).errors.some(e => /missing param "k"/.test(e.msg)));
});

test("product's two factors each draw their own influence arrow", () => {
  const { model } = ok(`
    node pressure : range(0, 300), init(0)
    node pulse    : range(0, 200), init(50)
    node volume   : range(0, 200), init(50)
    heart -> pressure : product(of = pulse, by = volume, k = 0.01)`);
  const reads = S.influences(model).filter(i => i.kind === "read" && i.to.edge === "heart->pressure").map(i => i.from).sort();
  assert.deepEqual(reads, ["pulse", "volume"]);   // both, since neither is the source (heart)
});

test("product unites the two loops: cardiac output = pulse × volume defends pressure, then decompensates", () => {
  const model = vol => `
    node pressure : range(0, 220), init(70)
    node pulse    : range(0, 200), init(70)
    node volume   : range(0, 120), init(${vol})
    external heart
    external body
    external nerves
    heart    -> pressure : product(of = pulse, by = volume, k = 0.0026)
    pressure -> body     : proportional(of = pressure, k = 0.1)
    nerves   -> pulse    : adjust(of = pressure, target = 93, k = 0.03)
    pathway resting : heart->pressure, pressure->body, nerves->pulse`;
  const P = v => settle(model(v), "pressure", { t: 1500, pathway: "resting" });
  const HR = v => settle(model(v), "pulse", { t: 1500, pathway: "resting" });
  assert.ok(near(P(50), 93, 1), `baseline holds 93, got ${P(50).toFixed(1)}`);
  assert.ok(near(P(25), 93, 1), `bad bleed still compensated at 93, got ${P(25).toFixed(1)}`);
  assert.ok(HR(25) > HR(50) + 30, "compensation = a faster pulse at lower volume");
  assert.ok(P(12) < 80, `severe bleed decompensates below setpoint, got ${P(12).toFixed(1)}`);   // pulse maxes, pressure falls
});

test("bullwhip: ignoring the supply line makes the order loop ring; accounting for it settles", () => {
  const { model } = ok(fs.readFileSync(path.join(DIR, "beer-game.strombild"), "utf8"));
  const run = pathway => {
    const eng = new S.Engine(model);
    eng.setPathway(pathway);
    const I = [];
    for (let i = 0; i < 240; i++) { eng.advance(0.25); I.push(eng.state.get("inventory")); }
    const peak = Math.max(...I), peakAt = I.indexOf(peak);
    const postMin = Math.min(...I.slice(peakAt));   // undershoot after the peak = ringing
    return { peak, postMin, final: I[I.length - 1] };
  };
  const naive = run("naive"), savvy = run("savvy");
  // both recover to the target shelf of 20
  assert.ok(near(naive.final, 20, 0.5) && near(savvy.final, 20, 0.5), "both settle at the target");
  // naive over-orders, overshooting harder than savvy...
  assert.ok(naive.peak > savvy.peak + 2, `naive overshoots more: ${naive.peak.toFixed(1)} vs ${savvy.peak.toFixed(1)}`);
  // ...then rings back below target, while savvy eases in without undershooting
  assert.ok(naive.postMin < 19, `naive rings below target, post-peak min ${naive.postMin.toFixed(1)}`);
  assert.ok(savvy.postMin > 19.5, `savvy settles cleanly, post-peak min ${savvy.postMin.toFixed(1)}`);
});

/* ---------------- pathways ---------------- */

test("pathway selection restricts which edges are live", () => {
  const { model } = ok(`
    node tub : range(0, 50), init(40)
    faucet -> tub : constant(c = 3)
    tub -> drain  : proportional(k = 0.1)
    tub -> sink2  : proportional(k = 0.5)
    pathway only_drain : faucet->tub, tub->drain
  `);
  const eng = new S.Engine(model);
  eng.setPathway("only_drain");
  assert.equal(eng.activeEdges().length, 2);
  eng.derivatives();
  assert.equal(eng.lastNet.get("tub"), 3 - 0.1 * 40);  // sink2 edge excluded
  eng.setPathway(null);                                 // all edges
  eng.derivatives();
  assert.equal(eng.activeEdges().length, 3);
  assert.equal(eng.lastNet.get("tub"), 3 - 0.1 * 40 - 0.5 * 40);
});

/* ---------------- reactions (recipe on the pathway) ---------------- */

test("a reaction pathway parses into kind/inputs/outputs/rate with coefficients", () => {
  const { model } = ok(`
    node a : range(0,50)
    node b : range(0,50)
    node c : range(0,50)
    pathway make : 2 a + b -> c : limiting(k = 0.5)
  `);
  const p = model.pathways.get("make");
  assert.equal(p.kind, "reaction");
  assert.deepEqual(p.inputs, [{ node: "a", coeff: 2 }, { node: "b", coeff: 1 }]);
  assert.deepEqual(p.outputs, [{ node: "c", coeff: 1 }]);
  assert.deepEqual(p.rate, { law: "limiting", params: { k: 0.5 } });
});

test("a selection pathway still parses as kind:selection (no rate law)", () => {
  const { model } = ok(`
    node tub : range(0,50)
    faucet -> tub : constant(c = 3)
    tub -> drain  : proportional(k = 0.1)
    pathway leaky : faucet->tub, tub->drain
  `);
  const p = model.pathways.get("leaky");
  assert.equal(p.kind, "selection");
  assert.deepEqual(p.refs, ["faucet->tub", "tub->drain"]);
});

test("a reaction without a rate law is an error", () => {
  const r = S.parseModel(`node a\nnode b\nnode c\npathway p : a + b -> c`);
  assert.ok(r.errors.some(e => /needs a rate law/.test(e.msg)));
});

test("unknown reaction rate law is an error", () => {
  const r = S.parseModel(`node a\nnode b\npathway p : a -> b : wobble(k = 1)`);
  assert.ok(r.errors.some(e => /unknown reaction rate law/.test(e.msg)));
});

test("undeclared reaction participant becomes an implicit external", () => {
  const r = S.parseModel(`node a : init(2)\nnode b : init(3)\npathway p : a + b -> c : mass_action(k = 1)`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.model.externals.get("c").role, "sink");
});

test("limiting rate = k * min(input/coeff), shared across participants", () => {
  const { model } = ok(`
    node a : range(0,50), init(8)
    node b : range(0,50), init(3)
    node c : range(0,50)
    pathway make : a + b -> c : limiting(k = 0.5)
  `);
  const eng = new S.Engine(model);
  eng.derivatives();
  assert.equal(eng.lastReactionRates.get("make"), 0.5 * 3);  // b is scarcer
  assert.equal(eng.lastNet.get("a"), -1.5);
  assert.equal(eng.lastNet.get("b"), -1.5);
  assert.equal(eng.lastNet.get("c"), +1.5);
});

test("coefficients scale consumption: 2 a + b -> c", () => {
  const { model } = ok(`
    node a : range(0,50), init(8)
    node b : range(0,50), init(3)
    node c : range(0,50)
    pathway make : 2 a + b -> c : limiting(k = 1)
  `);
  const eng = new S.Engine(model);
  eng.derivatives();
  // min(a/2, b/1) = min(4, 3) = 3  ->  rate 3; a drops by 2*3, c gains 3
  assert.equal(eng.lastReactionRates.get("make"), 3);
  assert.equal(eng.lastNet.get("a"), -6);
  assert.equal(eng.lastNet.get("c"), +3);
});

test("mass_action rate = k * product of inputs^coeff", () => {
  const { model } = ok(`
    node a : range(0,50), init(2)
    node b : range(0,50), init(3)
    node c : range(0,50)
    pathway make : a + b -> c : mass_action(k = 0.5)
  `);
  const eng = new S.Engine(model);
  eng.derivatives();
  assert.equal(eng.lastReactionRates.get("make"), 0.5 * 2 * 3);
});

test("factory bottleneck: slow supplier rate-limits, fast one piles up", () => {
  const src = `
    node supplyA : range(0,50), init(0)
    node supplyB : range(0,50), init(0)
    node factory : range(0,50), init(0)
    sourceA -> supplyA : constant(c = 1)
    sourceB -> supplyB : constant(c = 3)
    pathway assemble : supplyA + supplyB -> factory : limiting(k = 0.5)`;
  // A binds at supplyA=2 (1 = 0.5*2); B's inflow (3) outpaces use (1) -> caps at 50
  assert.ok(near(settle(src, "supplyA"), 2, 0.1), "A settles at the bottleneck level");
  assert.equal(settle(src, "supplyB", { t: 100 }), 50, "B piles up to capacity");
  assert.equal(settle(src, "factory", { t: 100 }), 50, "factory fills at the bottleneck rate");
});

test("competition: 'all' runs both recipes; selecting one isolates it", () => {
  const src = `
    node supplyA : range(0,50), init(0)
    node supplyB : range(0,50), init(0)
    node widget  : range(0,50), init(0)
    node gadget  : range(0,50), init(0)
    sourceA -> supplyA : constant(c = 1)
    sourceB -> supplyB : constant(c = 3)
    pathway make_widget : supplyA + supplyB -> widget : limiting(k = 0.5)
    pathway make_gadget : 2 supplyA + supplyB -> gadget : limiting(k = 0.5)`;
  // no pathway -> both reactions run, both products accumulate
  assert.ok(settle(src, "widget", { t: 100 }) > 1, "widget made when all run");
  assert.ok(settle(src, "gadget", { t: 100 }) > 1, "gadget made when all run");
  // select one recipe -> the other never runs
  assert.ok(settle(src, "gadget", { t: 100, pathway: "make_widget" }) === 0, "gadget idle under make_widget");
  assert.ok(settle(src, "widget", { t: 100, pathway: "make_widget" }) > 1, "widget still made");
});

test("selecting a reaction keeps transport edges live (supplies still fill)", () => {
  const { model } = ok(`
    node supplyA : range(0,50)
    node factory : range(0,50)
    sourceA -> supplyA : constant(c = 1)
    pathway assemble : supplyA -> factory : limiting(k = 0.5)`);
  const eng = new S.Engine(model);
  eng.setPathway("assemble");
  assert.equal(eng.activeEdges().length, 1);              // sourceA->supplyA stays on
  assert.equal(eng.activeReactions().length, 1);
});

/* ---------------- events (discrete reset) ---------------- */

test("an event parses into guard + actions", () => {
  const { model } = ok(`
    node widget  : range(0, 50), init(0)
    node shipped : range(0, 200), init(0)
    event ship : widget >= 20 : widget = 0, shipped += 20
  `);
  assert.equal(model.events.length, 1);
  const ev = model.events[0];
  assert.equal(ev.name, "ship");
  assert.deepEqual(ev.guard, [{ node: "widget", op: ">=", rhs: 20 }]);
  assert.deepEqual(ev.actions, [
    { node: "widget", op: "=", value: 0 },
    { node: "shipped", op: "+=", value: 20 },
  ]);
});

test("event needs guard and action (two colons)", () => {
  const r = S.parseModel(`node w : range(0,50)\nevent ship : w >= 20`);
  assert.ok(r.errors.some(e => /<guard> : <action>/.test(e.msg)));
});

test("bad guard and non-number action value are errors", () => {
  const g = S.parseModel(`node w : range(0,50)\nevent e : w & 20 : w = 0`);
  assert.ok(g.errors.some(e => /bad guard/.test(e.msg)));
  const a = S.parseModel(`node w : range(0,50)\nevent e : w >= 20 : w = full`);
  assert.ok(a.errors.some(e => /action value must be a number/.test(e.msg)));
});

test("event watching/assigning a non-node warns but parses", () => {
  const r = S.parseModel(`node w : range(0,50)\nevent e : ghost >= 5 : w = 0, phantom += 1`);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some(w => /watches "ghost"/.test(w.msg)));
  assert.ok(r.warnings.some(w => /assigns to "phantom"/.test(w.msg)));
});

test("event fires on rising edge: a stock crossing its guard resets and counts", () => {
  const { model } = ok(`
    node widget  : range(0, 50), init(0)
    node shipped : range(0, 200), init(0)
    feed -> widget : constant(c = 1)
    event ship : widget >= 20 : widget = 0, shipped += 20
  `);
  const eng = new S.Engine(model);
  eng.advance(110);                       // widget fills at 1/t -> 5 trucks ship by t=110
  assert.ok(eng.state.get("widget") < 20, "dock never sits above the load");
  assert.equal(eng.state.get("shipped"), 100, "5 trucks * 20 = 100 delivered");
});

test("event is edge-triggered: it does not re-fire every substep while true", () => {
  // guard stays true (nothing lowers the watched stock), so the counter must
  // tick exactly once, not once per substep.
  const { model } = ok(`
    node level : range(0, 50), init(0)
    node count : range(0, 50), init(0)
    feed -> level : constant(c = 5)
    event mark : level >= 10 : count += 1
  `);
  const eng = new S.Engine(model);
  eng.advance(50);
  assert.equal(eng.state.get("level"), 50, "level just fills to capacity");
  assert.equal(eng.state.get("count"), 1, "fired once on the crossing, not repeatedly");
});

test("a model starting above the guard does not fire spuriously at reset", () => {
  const { model } = ok(`
    node level : range(0, 50), init(30)
    node count : range(0, 50), init(0)
    event mark : level >= 10 : count += 1
  `);
  const eng = new S.Engine(model);
  eng.advance(5);
  assert.equal(eng.state.get("count"), 0, "armed from the initial state, so no false fire");
  assert.deepEqual(eng.lastEventFires, []);
});

test("a compound guard parses into a conjunction of clauses", () => {
  const { model } = ok(`
    node cdk  : range(0, 12), init(0)
    node dead : range(0, 1),  init(0)
    feed -> cdk : constant(c = 1)
    event divide : cdk >= 10 & dead == 0 : cdk = 0
  `);
  assert.deepEqual(model.events[0].guard, [
    { node: "cdk", op: ">=", rhs: 10 },
    { node: "dead", op: "==", rhs: 0 },
  ]);
});

test("a compound guard fires only when every clause holds (a dead cell stops dividing)", () => {
  const { model } = ok(`
    node cdk       : range(0, 12), init(0)
    node dead      : range(0, 1),  init(0)
    node divisions : range(0, 40), init(0)
    feed -> cdk : constant(c = 2)
    event divide : cdk >= 10 & dead == 0 : cdk = 0, divisions += 1
    event die    : divisions >= 3 & dead == 0 : dead = 1, cdk = 0
  `);
  const eng = new S.Engine(model);
  eng.advance(200);
  // die latches dead=1 at the 3rd division; the dead==0 clause then gates BOTH
  // events, so divisions freeze at 3 and die fires exactly once.
  assert.equal(eng.state.get("dead"), 1);
  assert.equal(eng.state.get("divisions"), 3, "dividing stops once dead");
  assert.equal(eng.eventFires.get("die"), 1, "die fires once, not repeatedly");
});

test("each distinct guard clause node yields an influence read", () => {
  const { model } = ok(`
    node cdk  : range(0, 12), init(0)
    node dead : range(0, 1),  init(0)
    feed -> cdk : constant(c = 1)
    event divide : cdk >= 10 & dead == 0 : cdk = 0
  `);
  const reads = S.influences(model).filter(i => i.kind === "read" && i.to.event === "divide");
  assert.ok(reads.some(r => r.from === "cdk"),  "guard read cdk->event");
  assert.ok(reads.some(r => r.from === "dead"), "guard read dead->event");
});

test("event assignments clamp to the node's range", () => {
  const { model } = ok(`
    node tally : range(0, 100), init(95)
    feed -> trigger : constant(c = 1)
    node trigger : range(0, 50), init(0)
    event bump : trigger >= 5 : tally += 20
  `);
  const eng = new S.Engine(model);
  eng.advance(20);
  assert.ok(eng.state.get("tally") <= 100, "tally clamped at capacity, not 115");
});

/* ---------------- analysis (fate detection) ---------------- */

const SWITCH = init => `
  node x : range(0, 50), init(${init})
  src -> x : hill(of = x, max = 8, k = 25, n = 4)
  x -> sink : proportional(of = x, k = 0.15)`;

test("equilibria finds the bistable structure: off / knife-edge / capacity", () => {
  const { model } = ok(SWITCH(0));
  const fps = S.equilibria(model, "x");
  const stable = fps.filter(f => f.stable).map(f => f.level);
  const unstable = fps.filter(f => !f.stable).map(f => f.level);
  assert.equal(unstable.length, 1, "exactly one knife-edge");
  assert.ok(near(unstable[0], 23.6, 0.5), `knife-edge ~23.6, got ${unstable[0]}`);
  assert.ok(stable.some(l => near(l, 0, 0.2)), "stable OFF at 0");
  assert.ok(stable.some(l => near(l, 50, 0.2)), "stable packed at capacity");
});

test("knifeEdge matches the basin boundary the engine actually integrates to", () => {
  const { model } = ok(SWITCH(0));
  const edge = S.knifeEdge(model, "x");
  // seeding just below the knife collapses; just above latches on
  assert.ok(near(settle(SWITCH(Math.floor(edge) - 1), "x"), 0, 0.5));
  assert.ok(near(settle(SWITCH(Math.ceil(edge) + 1), "x"), 50, 0.5));
});

test("a monotone stock has no knife-edge", () => {
  const { model } = ok(`
    node tub : range(0, 50)
    faucet -> tub : constant(c = 3)
    tub -> drain  : proportional(k = 0.1)`);
  assert.equal(S.knifeEdge(model, "tub"), null);
  const fps = S.equilibria(model, "tub");
  assert.equal(fps.length, 1);
  assert.ok(near(fps[0].level, 30, 0.2) && fps[0].stable);
});

/* ---------------- fateScan (the French-flag reading) ---------------- */

// one held input read against two thresholds -> three ordered territories
const FLAG = `
  node morphogen : range(0, 100), init(45)
  node switchA   : range(0, 10), init(0) @ bucket(threshold = 5)
  node switchB   : range(0, 10), init(0) @ bucket(threshold = 5)
  external source
  external sink
  source -> switchA : hill(of = morphogen, max = 10, k = 30, n = 8)
  source -> switchB : hill(of = morphogen, max = 10, k = 65, n = 8)
  switchA -> sink   : proportional(of = switchA, k = 1)
  switchB -> sink   : proportional(of = switchB, k = 1)`;

const fateAt = (scan, M) => {
  const c = scan.columns.reduce((a, b) => Math.abs(b.x - M) < Math.abs(a.x - M) ? b : a);
  return { onA: c.on.switchA, onB: c.on.switchB };
};

test("fateScan: three ordered territories along one gradient", () => {
  const { model } = ok(FLAG);
  const scan = S.fateScan(model, "morphogen", ["switchA", "switchB"]);
  const lo = fateAt(scan, 10), mid = fateAt(scan, 45), hi = fateAt(scan, 90);
  assert.deepEqual([lo.onA, lo.onB],   [false, false], "low end: both off (blue)");
  assert.deepEqual([mid.onA, mid.onB], [true, false],  "middle: A on, B off (white)");
  assert.deepEqual([hi.onA, hi.onB],   [true, true],   "high end: both on (red)");
});

test("fateScan: boundaries land on the hill half-maxes, A before B", () => {
  const { model } = ok(FLAG);
  const scan = S.fateScan(model, "morphogen", ["switchA", "switchB"]);
  assert.ok(near(scan.boundaries.switchA, 30, 1.5), `A turns on ~30, got ${scan.boundaries.switchA}`);
  assert.ok(near(scan.boundaries.switchB, 65, 1.5), `B turns on ~65, got ${scan.boundaries.switchB}`);
  assert.ok(scan.boundaries.switchA < scan.boundaries.switchB, "A's threshold is below B's");
});

test("fateScan: the fourth combination (B on, A off) never occurs", () => {
  const { model } = ok(FLAG);
  const scan = S.fateScan(model, "morphogen", ["switchA", "switchB"]);
  assert.ok(scan.columns.every(c => !(c.on.switchB && !c.on.switchA)),
    "one ordered input cannot light B without A");
});

test("fateScan: returns null for a missing input or no readouts", () => {
  const { model } = ok(FLAG);
  assert.equal(S.fateScan(model, "nope", ["switchA"]), null);
  assert.equal(S.fateScan(model, "morphogen", ["nope"]), null);
});

// a bistable switch: café-style self-activation + a morphogen bias. The fate now
// depends on history, so the two sweep directions bracket the hysteresis loop.
const FLAG_BISTABLE = `
  node morphogen : range(0, 100), init(45)
  node switchA : range(0, 12), init(0) @ bucket(threshold = 5)
  node switchB : range(0, 12), init(0) @ bucket(threshold = 5)
  external auto
  external drive
  external sink
  auto  -> switchA : hill(of = switchA, max = 8, k = 5, n = 4)
  drive -> switchA : proportional(of = morphogen, k = 0.068)
  auto  -> switchB : hill(of = switchB, max = 8, k = 5, n = 4)
  drive -> switchB : proportional(of = morphogen, k = 0.032)
  switchA -> sink  : proportional(of = switchA, k = 1)
  switchB -> sink  : proportional(of = switchB, k = 1)`;

test("fateScan from:lo is the default (a naive field)", () => {
  const { model } = ok(FLAG_BISTABLE);
  const def = S.fateScan(model, "morphogen", ["switchA", "switchB"], { settle: 80 });
  const lo  = S.fateScan(model, "morphogen", ["switchA", "switchB"], { from: "lo", settle: 80 });
  assert.deepEqual(def.boundaries, lo.boundaries);
});

test("fateScan: a bistable switch turns ON higher than it turns OFF (hysteresis)", () => {
  const { model } = ok(FLAG_BISTABLE);
  const up = S.fateScan(model, "morphogen", ["switchA", "switchB"], { from: "lo", settle: 80 });
  const dn = S.fateScan(model, "morphogen", ["switchA", "switchB"], { from: "hi", settle: 80 });
  // the turn-on edge sits well above the turn-off edge, for both switches
  assert.ok(up.boundaries.switchA > dn.boundaries.switchA + 10, "A: on-edge above off-edge");
  assert.ok(up.boundaries.switchB > dn.boundaries.switchB + 10, "B: on-edge above off-edge");
  // and A still trips before B on each branch (the order is preserved)
  assert.ok(up.boundaries.switchA < up.boundaries.switchB);
  assert.ok(dn.boundaries.switchA < dn.boundaries.switchB);
});

test("fateScan: inside the hysteresis band the same position yields two fates", () => {
  const { model } = ok(FLAG_BISTABLE);
  const up = S.fateScan(model, "morphogen", ["switchA", "switchB"], { from: "lo", settle: 80 });
  const dn = S.fateScan(model, "morphogen", ["switchA", "switchB"], { from: "hi", settle: 80 });
  const at = (scan, M) => scan.columns.reduce((a, b) => Math.abs(b.x - M) < Math.abs(a.x - M) ? b : a);
  // M=45 is below A's on-edge (~30? no — above) but within B's band: naive=white, primed=red
  const naive = at(up, 45), primed = at(dn, 45);
  assert.deepEqual([naive.on.switchA, naive.on.switchB], [true, false], "naive at 45: white");
  assert.deepEqual([primed.on.switchA, primed.on.switchB], [true, true], "primed at 45: red");
});

test("node visual primitive and fill kind are recorded", () => {
  const m = ok(`node factory : range(0,50) @ box(fill = squares)`).model.nodes.get("factory");
  assert.equal(m.visual, "box");
  assert.equal(m.fill, "squares");
  const d = ok(`node tub : range(0,50)`).model.nodes.get("tub");   // defaults
  assert.equal(d.visual, "bucket");
  assert.equal(d.fill, "water");
  const u = S.parseModel(`node x : range(0,50) @ blob(fill = squares)`);
  assert.ok(u.warnings.some(w => /unknown node visual/.test(w.msg)));
  assert.equal(u.model.nodes.get("x").visual, "bucket");           // falls back
  const bf = S.parseModel(`node x : range(0,50) @ box(fill = goo)`);
  assert.ok(bf.warnings.some(w => /unknown fill/.test(w.msg)));
});

test("edge visual primitive is recorded; rotor is a flux drawn as spin", () => {
  const m = ok(`
    node dam : range(0,100)
    external src
    external out
    src -> dam : constant(c = 8)
    dam -> out : proportional(of = dam, k = 0.3) @ rotor
  `).model;
  assert.equal(m.edges.find(e => e.id === "dam->out").visual, "rotor");
  assert.equal(m.edges.find(e => e.id === "src->dam").visual, "pipe");   // defaults to pipe
  // an unknown edge visual warns and falls back to pipe (still runs)
  const u = S.parseModel(`
    node dam : range(0,100)
    external src
    src -> dam : constant(c = 8) @ sprocket
  `);
  assert.ok(u.warnings.some(w => /unknown edge visual/.test(w.msg)));
  assert.equal(u.model.edges[0].visual, "pipe");
});

test("a reaction can carry an @ rotor visual (a motor hub); defaults to pipe", () => {
  const eq = law => `
    node a : range(0,100)
    node b : range(0,100)
    node c : range(0,100)
    external sa
    external sb
    sa -> a : constant(c = 5)
    sb -> b : constant(c = 5)
    pathway mk : a + b -> c : ${law}`;
  assert.equal(ok(eq("limiting(k = 0.4) @ rotor")).model.pathways.get("mk").visual, "rotor");
  assert.equal(ok(eq("limiting(k = 0.4)")).model.pathways.get("mk").visual, "pipe");   // defaults
  const u = S.parseModel(eq("limiting(k = 0.4) @ sprocket"));
  assert.ok(u.warnings.some(w => /unknown reaction visual/.test(w.msg)));
  assert.equal(u.model.pathways.get("mk").visual, "pipe");                              // falls back, still runs
});

test("mito-demand: the motor is an AND-gate — either feed dry stalls it, both feed it", () => {
  const src = fs.readFileSync(path.join(DIR, "mito-demand.strombild"), "utf8");
  const motorAt = (g, d) => {
    const { model } = ok(src);
    model.nodes.get("glucose").init = g;
    model.nodes.get("demand").init = d;
    const eng = new S.Engine(model);
    eng.advance(1500);
    return eng.lastReactionRates.get("motor");
  };
  assert.ok(near(motorAt(100, 0), 0), "no demand -> ADP starves -> stall");
  assert.ok(near(motorAt(0, 100), 0), "no fuel -> gradient flat -> stall");
  const both = motorAt(60, 60);
  assert.ok(both > 1, "both present -> motor runs");
  assert.ok(motorAt(30, 60) < both, "pinching glucose throttles the motor (protons bind)");
  assert.ok(motorAt(60, 30) < both, "pinching demand throttles the motor (ADP binds)");
});

test("mito-fuel: lowering glucose drops the reservoir reserve and the ATP output", () => {
  const src = fs.readFileSync(path.join(DIR, "mito-fuel.strombild"), "utf8");
  const at = g => {
    const { model } = ok(src);
    model.nodes.get("glucose").init = g;              // the dial is the experiment
    const eng = new S.Engine(model);
    eng.advance(800);
    return { res: eng.state.get("reservoir"), atp: eng.state.get("atp"), spin: eng.lastFlows.get("reservoir->matrix") };
  };
  const hi = at(70), lo = at(30), off = at(0);
  assert.ok(hi.res > lo.res && lo.res > off.res, "reservoir reserve falls as glucose falls");
  assert.ok(hi.atp > lo.atp && lo.atp > off.atp, "ATP output falls as glucose falls");
  assert.ok(near(off.res, 0) && near(off.atp, 0) && near(off.spin, 0), "no fuel -> dam empty, rotor stalled");
});

test("threshold visual param parses (auto and numeric)", () => {
  assert.equal(ok(`node p : range(0,50) @ bucket(fill = dots, threshold = auto)`).model.nodes.get("p").threshold, "auto");
  assert.equal(ok(`node p : range(0,50) @ bucket(threshold = 24)`).model.nodes.get("p").threshold, 24);
  assert.equal(ok(`node p : range(0,50) @ bucket(fill = water)`).model.nodes.get("p").threshold, null);
  const bad = S.parseModel(`node p : range(0,50) @ bucket(threshold = high)`);
  assert.ok(bad.warnings.some(w => /threshold must be/.test(w.msg)));
});

/* ---------------- influences (dashed couplings, not flows) ---------------- */

test("a rate law's third-party `of` read becomes a read influence onto its edge", () => {
  const { model } = ok(`
    node cyclin : range(0, 18)
    node apc    : range(0, 12)
    ribosome -> cyclin : constant(c = 1)
    cyclin   -> bin     : proportional(of = apc, k = 0.6)`);
  const inf = S.influences(model);
  // constant reads nothing; the apc-controlled destruction is one read arrow
  assert.equal(inf.length, 1);
  assert.deepEqual(inf[0], { kind: "read", from: "apc", to: { edge: "cyclin->bin" } });
});

test("self-feedback (of == dest) is drawn; the default (of == src) is not", () => {
  const fb = S.influences(ok(`
    node crowd : range(0, 50)
    street -> crowd : hill(of = crowd, max = 8, k = 25, n = 4)
    crowd  -> exit  : proportional(of = crowd, k = 0.15)`).model);
  // street->crowd reads crowd (its dest) = feedback -> drawn;
  // crowd->exit reads crowd (its src) = default -> not drawn
  assert.equal(fb.length, 1);
  assert.deepEqual(fb[0], { kind: "read", from: "crowd", to: { edge: "street->crowd" } });
});

test("an event yields a guard read and one write per distinct action target", () => {
  const { model } = ok(`
    node cyclin    : range(0, 18)
    node mpf       : range(0, 8)
    node divisions : range(0, 40)
    cdk -> mpf : hill(of = cyclin, max = 10, k = 15, n = 8)
    mpf -> cdk : proportional(of = mpf, k = 0.5)
    event divide : mpf >= 6 : cyclin = 0, mpf = 0, divisions += 1`);
  const inf = S.influences(model);
  // cdk->mpf reads cyclin (read); mpf->cdk reads its own src (skipped);
  // guard reads mpf (read); writes to cyclin, mpf, divisions
  const reads = inf.filter(i => i.kind === "read");
  const writes = inf.filter(i => i.kind === "write");
  assert.ok(reads.some(r => r.from === "cyclin" && r.to.edge === "cdk->mpf"), "of-read cyclin->edge");
  assert.ok(reads.some(r => r.from === "mpf" && r.to.event === "divide"), "guard read mpf->event");
  assert.deepEqual(writes.map(w => w.to).sort(), ["cyclin", "divisions", "mpf"]);
  assert.ok(writes.every(w => w.from.event === "divide"));
});

test("influences ignores reads that point at a non-node (e.g. an external)", () => {
  const { model } = ok(`
    node tub : range(0, 50)
    faucet -> tub : constant(c = 3)
    tub -> drain  : proportional(of = tub, k = 0.1)`);
  assert.deepEqual(S.influences(model), []);   // constant reads nothing; drain reads its src
});

test("layout places an event glyph keyed by name, distinct from nodes", () => {
  const { model } = ok(`
    node mpf       : range(0, 8)
    node divisions : range(0, 40)
    cdk -> mpf : hill(of = mpf, max = 10, k = 15, n = 8)
    event divide : mpf >= 6 : mpf = 0, divisions += 1`);
  const pos = S.layout(model, 800, 300);
  const g = pos.get("event:divide");
  assert.ok(g && g.kind === "event", "event glyph present");
  assert.equal(g.name, "divide");
});

/* ---------------- layout ---------------- */

test("linear chain ranks left-to-right: source < stock < sink", () => {
  const { model } = ok(`
    node tub : range(0, 50)
    faucet -> tub : constant(c = 3)
    tub -> drain  : proportional(k = 0.1)
  `);
  const pos = S.layout(model, 800, 300);
  assert.ok(pos.get("faucet").rank < pos.get("tub").rank);
  assert.ok(pos.get("tub").rank < pos.get("drain").rank);
});

test("crowded rank keeps buckets from overlapping their neighbour's label", () => {
  // four held dials all land in rank 0; the even spread alone would compress
  // them to ~one bucket-height and the lower labels would sit on the rim above.
  const { model } = ok(`
    node a : range(0, 100), init(50)
    node b : range(0, 100), init(50)
    node c : range(0, 100), init(50)
    node d : range(0, 100), init(50)
  `);
  const pos = S.layout(model, 800, 460);
  const ys = ["a", "b", "c", "d"].map(n => pos.get(n).y).sort((p, q) => p - q);
  // a bucket is 104 tall; consecutive centres must clear that plus a label band.
  for (let i = 1; i < ys.length; i++)
    assert.ok(ys[i] - ys[i - 1] >= 104 + 20, `rank rows too tight: ${ys[i] - ys[i - 1]}`);
});

/* ---------------- the on-disk example files all parse ---------------- */

for (const file of ["tub1.strombild", "tub2.strombild", "cafe.strombild", "gene-express.strombild",
                     "factory1.strombild", "factory2.strombild", "factory3.strombild",
                     "cell-cycle.strombild", "cell-cycle-divide.strombild",
                     "french-flag.strombild", "french-flag-bistable.strombild",
                     "cytokine.strombild", "cytokine-arms-race.strombild", "cytokine-inflammation.strombild",
                     "strait.strombild", "beer-game.strombild", "golgi.strombild",
                     "mitochondria.strombild", "mito-fuel.strombild", "mito-demand.strombild"]) {
  test(`example file parses without errors: ${file}`, () => {
    const p = path.join(DIR, file);
    if (!fs.existsSync(p)) return;                       // tolerate missing
    const r = S.parseModel(fs.readFileSync(p, "utf8"));
    assert.deepEqual(r.errors, [], `${file} had errors:\n` + JSON.stringify(r.errors, null, 2));
  });
}
