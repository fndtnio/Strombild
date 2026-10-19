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

/* ---------------- bone: the mechanostat ---------------- */

const BONE = () => fs.readFileSync(path.join(DIR, "bone.strombild"), "utf8");
// settle the on-disk bone model at a given habitual load
function bone(load, { t = 6000, src = BONE() } = {}) {
  const { model } = ok(src);
  const eng = new S.Engine(model);
  eng.state.set("load", load);
  eng.advance(t);
  return { strain: eng.state.get("strain"), mineral: eng.state.get("mineral") };
}

test("mechanostat: bone settles where strain sits at the setpoint", () => {
  const { strain, mineral } = bone(1500);
  assert.ok(near(strain, 1500, 1), `strain holds its setpoint, got ${strain.toFixed(0)}`);
  assert.ok(near(mineral, 100, 0.5), `mineral is 100 by definition there, got ${mineral.toFixed(1)}`);
});

test("the controller defends STRAIN and spends MASS to do it", () => {
  // the whole claim of the model: cut the load threefold and strain does *not*
  // fall threefold — bone is given up until the thinner bone strains more again.
  const habitual = bone(1500), desk = bone(500);
  assert.ok(desk.mineral < 70, `mass is spent: ${desk.mineral.toFixed(1)}`);
  const loadRatio = 1500 / 500, strainRatio = habitual.strain / desk.strain;
  assert.ok(strainRatio < loadRatio / 1.5,
    `strain is partly defended: fell ${strainRatio.toFixed(2)}x against a ${loadRatio}x load cut`);
});

test("strain really is force / bone — the fast stock computes the division", () => {
  for (const load of [500, 1500, 2500]) {
    const { strain, mineral } = bone(load);
    assert.ok(near(strain, 100 * load / mineral, 1),
      `load ${load}: strain ${strain.toFixed(0)} vs load/bone ${(100 * load / mineral).toFixed(0)}`);
  }
});

test("more load buys more bone, monotonically, with a ceiling", () => {
  const m = [200, 800, 1500, 2500, 3000].map(l => bone(l).mineral);
  for (let i = 1; i < m.length; i++) assert.ok(m[i] > m[i - 1], `monotone at ${i}: ${m}`);
  assert.ok(m[m.length - 1] < 140, "the hill saturates: bone does not run away");
});

test("the disuse floor IS the basal formation arm, not a clamp", () => {
  // c/k = 0.3/0.005 = 60, and below the mechanostat's threshold it is flat:
  // the floor does not care how little load there is, which is the claim.
  assert.ok(near(bone(200).mineral, 60, 1), `floor at ~60, got ${bone(200).mineral.toFixed(1)}`);
  assert.ok(near(bone(0).mineral, 60, 1), "the same floor with no load at all");
  // Delete that one line and there is no floor: formation is then load-only, so
  // bone tracks the load all the way down and hits zero at zero. (The strain
  // feedback still slows the fall — a wheelchair-ish 200 lands near 18, not 0 —
  // but predicting the loss of four-fifths of a skeleton is still false.)
  const noBasal = BONE().split("\n").filter(l => !/^\s*marrow\s*->/.test(l)).join("\n");
  const t = 20000;
  assert.ok(bone(0, { src: noBasal, t }).mineral < 0.5, "no load, no bone at all");
  assert.ok(bone(200, { src: noBasal, t }).mineral < 25,
    "and a near-disuse load costs most of the skeleton, which is why the line is there");
});

test("the speed limit: a twelve-week study cannot see this", () => {
  const { model } = ok(BONE());
  const eng = new S.Engine(model);
  eng.advance(6000);                                   // settle at the habitual load
  const before = eng.state.get("mineral");
  eng.state.set("load", 2500);                         // start jumping
  const at = wk => { eng.advance(6000 + wk - eng.t); return eng.state.get("mineral"); };
  const twelve = at(12), final = bone(2500).mineral;
  const fraction = (twelve - before) / (final - before);
  assert.ok(final - before > 20, "the change is worth having, eventually");
  assert.ok(fraction < 0.1,
    `<10% of it has happened at 12 weeks, got ${(100 * fraction).toFixed(1)}%`);
});

/* ---------------- vo2max: two arms on two clocks ---------------- */

const VO2 = () => fs.readFileSync(path.join(DIR, "vo2max.strombild"), "utf8");
// settle the on-disk vo2max model at a given (intensity, volume) prescription
function vo2(intensity, volume, { t = 3000, eng = null } = {}) {
  const e = eng || new S.Engine(ok(VO2()).model);
  e.state.set("intensity", intensity);
  e.state.set("volume", volume);
  e.advance(t);
  return { plasma: e.state.get("plasma"), mito: e.state.get("mito"), vo2max: e.state.get("vo2max"), eng: e };
}

test("Fick is a product: the combination beats the sum of its parts", () => {
  // the structural argument for polarized training — it falls out of the ×,
  // and a model that ADDED the two arms could not produce it.
  const base = vo2(40, 1).vo2max;
  const volumeOnly = vo2(40, 12).vo2max - base;
  const intensityOnly = vo2(95, 1).vo2max - base;
  const both = vo2(95, 12).vo2max - base;
  assert.ok(volumeOnly > 5 && intensityOnly > 5, `each arm alone helps: ${volumeOnly}, ${intensityOnly}`);
  assert.ok(both > volumeOnly + intensityOnly,
    `together (${both.toFixed(1)}) exceeds the sum (${(volumeOnly + intensityOnly).toFixed(1)})`);
});

test("intensity is a THRESHOLD, volume is a DOSE", () => {
  // the model's actual claim: the two arms respond to different quantities and
  // in different shapes, so a study varying one cannot see the other.
  const atI = i => vo2(i, 6).vo2max, atV = v => vo2(85, v).vo2max;
  // below the threshold intensity buys almost nothing; across it, a lot
  const low = atI(50) - atI(40), across = atI(80) - atI(70);
  assert.ok(across > 2 * low, `threshold: ${low.toFixed(2)} below vs ${across.toFixed(2)} across`);
  // volume has no threshold — equal steps buy equal amounts, all the way up
  const steps = [2, 4, 6, 8, 10, 12].map(v => atV(v) - atV(v - 2));
  const spread = Math.max(...steps) - Math.min(...steps);
  assert.ok(spread < 0.05, `dose: every 2-hour step is worth the same, spread ${spread.toFixed(3)}`);
});

test("detraining: a vacation and a season are different injuries", () => {
  const { eng, ...trained } = vo2(85, 6);
  const lost = (now, then) => (then - now) / (then - 4);      // fraction of the trained gain given back
  eng.state.set("intensity", 0); eng.state.set("volume", 0);
  const t0 = eng.t;
  eng.advance(t0 + 2 - eng.t);
  const twoWk = { v: eng.state.get("vo2max"), p: eng.state.get("plasma"), m: eng.state.get("mito") };
  eng.advance(t0 + 12 - eng.t);
  const twelveWk = { v: eng.state.get("vo2max"), p: eng.state.get("plasma"), m: eng.state.get("mito") };

  // two weeks: a real dent, and it is nearly all the fast arm
  const drop2 = 100 * (trained.vo2max - twoWk.v) / trained.vo2max;
  assert.ok(drop2 > 4 && drop2 < 11, `two weeks off costs a noticeable ${drop2.toFixed(1)}%`);
  assert.ok(lost(twoWk.p, trained.plasma) > 3 * lost(twoWk.m, trained.mito),
    "and the delivery arm gives back its gain several times faster than extraction");
  // twelve weeks: worse, and now the slow arm has gone too — a different problem
  const drop12 = 100 * (trained.vo2max - twelveWk.v) / trained.vo2max;
  assert.ok(drop12 > 2 * drop2, `twelve weeks is a different injury: ${drop12.toFixed(1)}%`);
  assert.ok(lost(twelveWk.m, trained.mito) > 0.4, "the extraction base is half gone by twelve weeks");
});

test("the slow arm rebuilds slowly — recovery is not symmetric with the loss", () => {
  const { eng } = vo2(85, 6);
  eng.state.set("intensity", 0); eng.state.set("volume", 0);
  eng.advance(12);                                        // a season off
  const detrained = eng.state.get("vo2max");
  eng.state.set("intensity", 85); eng.state.set("volume", 6);
  const t0 = eng.t, target = vo2(85, 6).vo2max;
  const back = wk => { eng.advance(t0 + wk - eng.t); return (eng.state.get("vo2max") - detrained) / (target - detrained); };
  const atFour = back(4), atSixteen = back(16);
  assert.ok(atFour < 0.55, `a month back recovers under half of it: ${(100 * atFour).toFixed(0)}%`);
  assert.ok(atSixteen > 0.85, `four months recovers most of it: ${(100 * atSixteen).toFixed(0)}%`);
});

test("this is the model you can test on yourself — unlike bone", () => {
  // an answerability calculation, run before any data is collected.
  const TEST_CV = 3.0;                                    // a good lab VO2max test, %
  const { eng } = vo2(40, 1);                             // start sedentary
  const base = eng.state.get("vo2max");
  eng.state.set("intensity", 85); eng.state.set("volume", 6);
  eng.advance(8);
  const gain = 100 * (eng.state.get("vo2max") - base) / base;
  assert.ok(gain > 3 * TEST_CV,
    `eight weeks moves ${gain.toFixed(1)}% against a ${TEST_CV}% CV — resolvable in one person`);
  // the contrast that makes the point: bone's 12-week signal sits inside DEXA's noise
  const DEXA_CV = 1.5;
  const b = ok(BONE()).model, be = new S.Engine(b);
  be.advance(6000);
  const b0 = be.state.get("mineral");
  be.state.set("load", 2500);
  be.advance(6012 - be.t);
  const boneGain = 100 * (be.state.get("mineral") - b0) / b0;
  assert.ok(boneGain < 2 * DEXA_CV,
    `bone's twelve-week signal (${boneGain.toFixed(1)}%) is inside DEXA's noise — never resolvable in one person`);
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

test("fitView is the identity when the layout fits, and scales it in when it does not", () => {
  // six held dials in one rank: at MIN_ROW spacing they need ~900px of height
  const { model } = ok(`
    node a : range(0, 100), init(50)
    node b : range(0, 100), init(50)
    node c : range(0, 100), init(50)
    node d : range(0, 100), init(50)
    node e : range(0, 100), init(50)
    node f : range(0, 100), init(50)
  `);
  const tall = S.layout(model, 800, 1200);
  assert.deepEqual(S.fitView(tall, 800, 1200), { s: 1, tx: 0, ty: 0 });
  const short = S.layout(model, 800, 400);
  const v = S.fitView(short, 800, 400);
  assert.ok(v.s < 1, `expected a shrink, got s=${v.s}`);
  // every box, with its label band, lands inside the canvas once scaled
  for (const p of short.values()) {
    const top = (p.y - p.h / 2 - 30) * v.s + v.ty, bot = (p.y + p.h / 2) * v.s + v.ty;
    assert.ok(top >= 0 && bot <= 400, `box ${top.toFixed(0)}..${bot.toFixed(0)} escapes a 400px canvas`);
  }
});

test("fitView: the iron model fits a laptop-height stage (the file that forced it)", () => {
  const r = S.parseModel(fs.readFileSync(path.join(DIR, "iron.strombild"), "utf8"));
  const pos = S.layout(r.model, 1000, 520);
  const v = S.fitView(pos, 1000, 520);
  for (const [name, p] of pos) {
    const bot = (p.y + p.h / 2) * v.s + v.ty;
    assert.ok(bot <= 520, `${name} falls off the bottom: ${bot.toFixed(0)} > 520`);
  }
});

/* ---------------- the on-disk example files all parse ---------------- */

// read the directory rather than listing files: a hand-kept list silently stops
// covering every example you add, which is the one thing this test is for.
const EXAMPLES = fs.readdirSync(DIR).filter(f => f.endsWith(".strombild")).sort();

test("there are examples on disk to check", () => {
  assert.ok(EXAMPLES.length > 20, `found only ${EXAMPLES.length} example files`);
});

for (const file of EXAMPLES) {
  test(`example file parses without errors: ${file}`, () => {
    const r = S.parseModel(fs.readFileSync(path.join(DIR, file), "utf8"));
    assert.deepEqual(r.errors, [], `${file} had errors:\n` + JSON.stringify(r.errors, null, 2));
  });
}

/* ---------------- repress, and the red-cell loop ---------------- */

test("repress: the inhibitory hill — full at 0, half at k, falling with what it reads", () => {
  const src = v => `
    node x : range(0, 100), init(${v})
    node y : range(0, 1000), init(0)
    external src
    src -> y : repress(of = x, max = 10, k = 20, n = 4)
    pathway p : src->y`;
  const rate = v => { const { model } = ok(src(v)); const eng = new S.Engine(model); eng.advance(1); return eng.state.get("y"); };
  assert.ok(near(rate(0), 10, 0.01), `full at 0, got ${rate(0)}`);
  assert.ok(near(rate(20), 5, 0.01), `half at k, got ${rate(20)}`);
  assert.ok(rate(40) < 0.7 && rate(40) > 0.5, `(1/17 of max) at 2k, got ${rate(40)}`);
  assert.ok(rate(5) > rate(10) && rate(10) > rate(20), "monotone decreasing");
  const { errors } = S.parseModel("node x : range(0,1)\nexternal s\ns -> x : repress(of = x, max = 1)");
  assert.ok(errors.length, "missing k and n is an error");
});

const ERY = fs.readFileSync(path.join(DIR, "erythropoiesis.strombild"), "utf8");
const PV = fs.readFileSync(path.join(DIR, "erythropoiesis-pv.strombild"), "utf8");
const eryWith = (edge, kidneyMax = 300) => ERY
  .replace("progenitors -> red_cells   : product(of = progenitors, by = epo, k = 0.00075)", edge)
  .replace("repress(of = red_cells, max = 300, k = 35, n = 8)", `repress(of = red_cells, max = ${kidneyMax}, k = 35, n = 8)`);

test("erythropoiesis settles where the textbook says: hematocrit 45, EPO 10", () => {
  assert.ok(near(settle(ERY, "red_cells", { t: 2000 }), 45, 1));
  assert.ok(near(settle(ERY, "epo", { t: 2000 }), 10, 1));
});

test("a bleed is defended: from 30 the hematocrit is back near 45 in weeks, and EPO rose to do it, then fell back", () => {
  const { model } = ok(ERY);
  const eng = new S.Engine(model);
  eng.state.set("red_cells", 30);
  eng.advance(1);  const epoDay1 = eng.state.get("epo");
  eng.advance(27); const hct4w = eng.state.get("red_cells");
  eng.advance(60); const epoLater = eng.state.get("epo");
  assert.ok(epoDay1 > 18, `EPO rose fast, got ${epoDay1.toFixed(1)}`);
  assert.ok(hct4w > 43, `hematocrit recovered, got ${hct4w.toFixed(1)}`);
  assert.ok(near(epoLater, 10, 1), `EPO back to baseline, got ${epoLater.toFixed(1)}`);
});

test("polycythemia vera is one edge: hematocrit climbs into the sixties and EPO falls below 1 — the loop intact and ignored", () => {
  const src = PV.replace("event phlebotomy : red_cells >= 55 : red_cells -= 5", "");
  assert.ok(settle(src, "red_cells", { t: 2000 }) > 60);
  assert.ok(settle(src, "epo", { t: 2000 }) < 1);
});

test("phlebotomy treats the stock: a sawtooth that never ends", () => {
  const { model } = ok(PV);
  const eng = new S.Engine(model);
  let fired = 0, prev = eng.state.get("red_cells"), maxHct = 0;
  for (let i = 0; i < 4000; i++) { eng.advance(0.25); const h = eng.state.get("red_cells"); if (h < prev - 3) fired++; prev = h; maxHct = Math.max(maxHct, h); }
  assert.ok(fired >= 3, `repeated phlebotomies, got ${fired}`);
  assert.ok(maxHct < 56, `held under the trigger, peak ${maxHct.toFixed(1)}`);
  assert.ok(settle(PV, "epo", { t: 2000 }) < 6, "and EPO stays low throughout — the kidney still sees too many red cells");
});

test("mechanism survives the experiment the outcome cannot distinguish: kidney off, PFCP's red cells fall, PV's do not", () => {
  const pfcp = eryWith("progenitors -> red_cells   : product(of = progenitors, by = epo, k = 0.00225)");
  const pfcpHct = settle(pfcp, "red_cells", { t: 2000 }), pfcpEpo = settle(pfcp, "epo", { t: 2000 });
  assert.ok(pfcpHct > 50 && pfcpHct < 55, `PFCP high red cells, got ${pfcpHct.toFixed(1)}`);
  assert.ok(pfcpEpo < 5, `PFCP low EPO, got ${pfcpEpo.toFixed(1)}`);        // same words as PV
  const pfcpOff = eryWith("progenitors -> red_cells   : product(of = progenitors, by = epo, k = 0.00225)", 0);
  const pvOff = eryWith("progenitors -> red_cells   : proportional(of = progenitors, k = 0.011)", 0);
  assert.ok(settle(pfcpOff, "red_cells", { t: 2000 }) < 5, "PFCP still needs EPO");
  assert.ok(settle(pvOff, "red_cells", { t: 2000 }) > 60, "PV does not");
  assert.ok(settle(eryWith("progenitors -> red_cells   : product(of = progenitors, by = epo, k = 0.00075)", 0), "red_cells", { t: 2000 }) < 5, "and neither does the healthy marrow without its kidney");
});

/* ---------------- clonal escape: the same mutation, three outcomes ---------------- */

const ESCAPE = fs.readFileSync(path.join(DIR, "clonal-escape.strombild"), "utf8");
const DIAL = "normal_hsc  -> mutant_hsc  : product(of = normal_hsc, by = mutant_hsc, k = 0.0024)";

// run a lifetime and report the age each clinical latch lit, plus the end state.
const lifetime = (advantage, years = 85) => {
  const src = advantage === null ? ESCAPE
    : ESCAPE.replace(DIAL, DIAL.replace("k = 0.0024", `k = ${advantage}`));
  const { model } = ok(src);
  const eng = new S.Engine(model);
  const at = {};
  let nicheMin = Infinity, nicheMax = -Infinity;
  for (let y = 1; y <= years; y++) {
    eng.advance(1);
    for (const f of ["mutated", "noticed", "diagnosable", "clot_zone"])
      if (at[f] === undefined && eng.state.get(f) >= 0.5) at[f] = y;
    const niche = eng.state.get("normal_hsc") + eng.state.get("mutant_hsc");
    nicheMin = Math.min(nicheMin, niche); nicheMax = Math.max(nicheMax, niche);
  }
  return {
    at,
    clone: eng.state.get("mutant_hsc"),
    hct: eng.state.get("red_cells"),
    epo: eng.state.get("epo"),
    nicheMin, nicheMax,
  };
};

test("clonal escape: the mutation is early and silent — nothing moves for decades after it lands", () => {
  const r = lifetime(null);
  assert.equal(r.at.mutated, 11, `the mutation fires in the eleventh year, got ${r.at.mutated}`);
  // thirty years later the blood count is still unremarkable: the gap the file exists for
  const { model } = ok(ESCAPE);
  const eng = new S.Engine(model);
  eng.advance(40);
  assert.ok(eng.state.get("mutant_hsc") > 0.5, "the clone is growing by forty");
  assert.ok(near(eng.state.get("red_cells"), 45, 1), `and the hematocrit has not moved, got ${eng.state.get("red_cells").toFixed(1)}`);
});

test("clonal escape: the shipped dial puts the PV criteria at about sixty — age of onset is an output", () => {
  const r = lifetime(null);
  assert.ok(r.at.noticed >= 50 && r.at.noticed <= 58, `first abnormal count in the fifties, got ${r.at.noticed}`);
  assert.ok(r.at.diagnosable >= 57 && r.at.diagnosable <= 64, `meets criteria near sixty, got ${r.at.diagnosable}`);
  assert.ok(r.at.clot_zone > r.at.diagnosable, "and the thrombotic range comes after it");
  assert.ok(r.hct > 60, `ends in the sixties, got ${r.hct.toFixed(1)}`);
  assert.ok(r.epo < 1, `with EPO suppressed — the PV fingerprint, got ${r.epo.toFixed(2)}`);
});

test("clonal escape: THREE outcomes from one dial — no escape, escape without disease, disease", () => {
  const none = lifetime(0.0004);          // 100k < drift
  assert.ok(none.clone < 0.02, `no escape: the clone dies back, got ${none.clone.toFixed(3)}`);
  assert.equal(none.at.noticed, undefined, "and no blood count ever looks odd");

  const carrier = lifetime(0.0012);       // 100k > drift, and too slow to matter
  assert.ok(carrier.clone > 0.5 && carrier.clone < 10,
    `clonal hematopoiesis: a real, detectable clone, got ${carrier.clone.toFixed(2)}%`);
  assert.ok(near(carrier.hct, 45, 1), `with a normal hematocrit for life, got ${carrier.hct.toFixed(1)}`);
  assert.equal(carrier.at.noticed, undefined, "never crosses into disease");

  const patient = lifetime(0.005);
  assert.ok(patient.at.diagnosable < 40, `a steeper dial is a young patient, got ${patient.at.diagnosable}`);

  // monotone: a bigger advantage is never a later disease
  const ages = [0.0024, 0.0035, 0.005, 0.008].map(k => lifetime(k).at.diagnosable);
  for (let i = 1; i < ages.length; i++)
    assert.ok(ages[i] <= ages[i - 1], `onset moves earlier as the dial rises, got ${ages.join(" > ")}`);
});

/* ---------------- iron: the material, and which constraint binds ---------------- */

const IRON = fs.readFileSync(path.join(DIR, "iron.strombild"), "utf8");
const PHLEB = "event phlebotomy : red_cells >= 47 : red_cells -= 4";
const HEPMAX = "hill(of = stores, max = 4.0, k = 19.2, n = 2)";
const MATURE = "by = erythroblasts, k = 0.1247)";
const ironRun = (src, days = 2500) => {
  const { model } = ok(src);
  const eng = new S.Engine(model);
  const gaps = [];
  let last = 0, prev = eng.state.get("red_cells"), lo = Infinity, hi = -Infinity;
  for (let d = 1; d <= days; d++) {
    eng.advance(1);
    const h = eng.state.get("red_cells");
    if (d > 300) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
    if (h < prev - 2) { gaps.push(d - last); last = d; }
    prev = h;
  }
  const g = n => eng.state.get(n);
  return { gaps, lo, hi, hct: g("red_cells"), stores: g("stores"),
           plasma: g("plasma_iron"), hep: g("hepcidin") };
};

test("iron: the loop is CLOSED — with the gut and the leak removed, total iron is conserved", () => {
  // THE BUG THIS TEST EXISTS FOR. The release edge first read hepcidin alone and not
  // `stores`, so an empty store went on releasing iron for ever — the model
  // MANUFACTURED the material it was supposed to be running out of, and produced a
  // tidy steady phlebotomy rhythm that was pure artefact.
  const closed = IRON
    .replace("diet          -> plasma_iron   : repress(of = hepcidin, max = 0.05, k = 1, n = 3)", "")
    .replace("stores        -> losses        : proportional(of = stores, k = 0.0013)", "")
    .replace(PHLEB, "");
  const { model } = ok(closed);
  const eng = new S.Engine(model);
  const total = () => eng.state.get("plasma_iron") + eng.state.get("stores") + eng.state.get("red_cells");
  const start = total();
  for (let d = 0; d < 1200; d++) {
    eng.advance(1);
    assert.ok(Math.abs(total() - start) < 0.05,
      `iron created or destroyed by day ${d}: ${start.toFixed(3)} -> ${total().toFixed(3)}`);
  }
});

test("iron: the healthy marrow sits where the textbook says, with full stores and an open-but-not-wide gate", () => {
  const healthy = IRON
    .replace("marrow        -> erythroblasts : constant(c = 61.0)",
             "marrow        -> erythroblasts : proportional(of = epo, k = 5.0)")
    .replace(PHLEB, "");
  const r = ironRun(healthy);
  assert.ok(near(r.hct, 45, 1), `hematocrit 45, got ${r.hct.toFixed(1)}`);
  assert.ok(near(r.stores, 19, 1), `stores replete, got ${r.stores.toFixed(1)}`);
  assert.ok(near(r.hep, 1, 0.1), `hepcidin at baseline, got ${r.hep.toFixed(2)}`);
  assert.equal(r.gaps.length, 0, "and nothing to treat");
});

test("iron: phlebotomy's interval LENGTHENS as the stores empty — the register's prose, as an output", () => {
  const r = ironRun(IRON);
  assert.ok(r.gaps.length > 8, `a repeating sawtooth, got ${r.gaps.length} phlebotomies`);
  const first = r.gaps[0], settled = r.gaps[r.gaps.length - 1];
  assert.ok(first < 90, `early phlebotomies are weeks apart, got ${first} days`);
  assert.ok(settled > 115, `settled ones are months apart, got ${settled} days`);
  assert.ok(settled > first * 1.5,
    `and the interval at least half as long again, ${first} -> ${settled}`);
  assert.ok(r.stores < 14, `because the iron went out with the blood, stores ${r.stores.toFixed(1)}`);
  assert.ok(r.hep < 0.6, `and the body opened its gate in response, hepcidin ${r.hep.toFixed(2)}`);
});

test("iron: the hepcidin mimetic holds the hematocrit WITHOUT stripping the iron — the drug's whole case", () => {
  const drug = IRON.replace(HEPMAX, "hill(of = stores, max = 4.3, k = 19.2, n = 2)");
  const r = ironRun(drug);
  assert.equal(r.gaps.length, 0, "the phlebotomies stop");
  assert.ok(r.lo > 42 && r.hi < 46, `held near target, band ${r.lo.toFixed(1)}-${r.hi.toFixed(1)}`);
  // THE CONTRAST IS THE POINT: same hematocrit, opposite iron.
  assert.ok(r.stores > 18, `and the stores stay full, got ${r.stores.toFixed(1)}`);
  assert.ok(r.stores > ironRun(IRON).stores + 5,
    "which is the difference between functional restriction and true deficiency");
  // the window is narrow, and overshooting it is anaemia — the drug's real toxicity
  const tooMuch = ironRun(IRON.replace(HEPMAX, "hill(of = stores, max = 5.0, k = 19.2, n = 2)"));
  assert.ok(tooMuch.lo < 30, `overshoot is anaemia, got ${tooMuch.lo.toFixed(1)}`);
});

test("iron: pushing on the MARROW edge does nothing, because iron is what binds", () => {
  // The file's real lesson, pinned. A model with one binding constraint can only
  // report "inert" or "decisive", never "therapeutic" — and this is the inert half.
  const base = ironRun(IRON);
  const slowed = ironRun(IRON.replace(MATURE, "by = erythroblasts, k = 0.02)"));  // a sixth of normal
  assert.ok(near(slowed.hct, base.hct, 0.5),
    `hematocrit unmoved: ${base.hct.toFixed(2)} vs ${slowed.hct.toFixed(2)}`);
  assert.ok(near(slowed.stores, base.stores, 0.5),
    `stores unmoved: ${base.stores.toFixed(2)} vs ${slowed.stores.toFixed(2)}`);
  assert.equal(slowed.gaps.length, base.gaps.length, "same number of phlebotomies");
  // the one thing that DOES move: iron backs up in front of a slower marrow
  assert.ok(slowed.plasma > base.plasma * 3,
    `iron queues instead: plasma ${base.plasma.toFixed(3)} -> ${slowed.plasma.toFixed(3)}`);
});

test("clonal escape: the niche is conserved — drift returns share rather than draining the marrow", () => {
  for (const k of [0.0004, 0.0024, 0.008]) {
    const r = lifetime(k);
    assert.ok(near(r.nicheMin, 100, 0.01) && near(r.nicheMax, 100, 0.01),
      `stem-cell total stays 100 at k=${k}, saw ${r.nicheMin.toFixed(3)}..${r.nicheMax.toFixed(3)}`);
  }
});


/* ---------------------------------------------------------------------
 * CONVEYORS — transit(T) + expire(). A stock whose contents carry an age.
 * ------------------------------------------------------------------- */
const CONV = (extra = "") => `
node cells : range(0, 80), init(45), transit(120) @ bucket(fill = water)
external marrow
external spleen
marrow -> cells  : constant(c = 0.375)
cells  -> spleen : expire()${extra}`;

test("conveyor: a flat age distribution plus a matched inflow is an exact steady state", () => {
  // init spreads the stock evenly over the last T, so it discharges evenly over
  // the next T. Loaded at age 0 instead, the whole stock would fire back out as
  // a pulse at t = T — the bug this default exists to prevent.
  const { model } = ok(CONV());
  const eng = new S.Engine(model);
  for (let d = 0; d < 500; d++) {
    eng.advance(1, 0.02);
    assert.ok(near(eng.state.get("cells"), 45, 1e-6),
      `day ${d + 1}: held ${eng.state.get("cells")}, want 45`);
  }
});

test("conveyor: with the inflow cut, a flat stock drains dead straight and is empty at exactly T", () => {
  const { model } = ok(`
node cells : range(0, 80), init(45), transit(120) @ bucket(fill = water)
external spleen
cells -> spleen : expire()`);
  const eng = new S.Engine(model);
  const at = {};
  for (let d = 1; d <= 130; d++) { eng.advance(1, 0.02); at[d] = eng.state.get("cells"); }
  for (const d of [30, 60, 90]) assert.ok(near(at[d], 45 * (120 - d) / 120, 1e-6),
    `linear drain at day ${d}: ${at[d].toFixed(4)} vs ${(45 * (120 - d) / 120).toFixed(4)}`);
  assert.ok(at[119] > 0, "still holding the last cohort at 119");
  assert.ok(near(at[120], 0, 1e-9), `empty at exactly T, got ${at[120]}`);
  assert.ok(near(at[130], 0, 1e-9), "stays empty");
});

test("conveyor: nothing leaves before T — an exact delay, not a smeared one", () => {
  // the linear-chain trick spreads a delay by 1/sqrt(N) and leaks from day 0.
  const { model } = ok(`
node cells : range(0, 400), init(0), transit(30) @ bucket(fill = dots)
external src
external out
src   -> cells : constant(c = 10)
cells -> out   : expire()`);
  const eng = new S.Engine(model);
  for (let d = 1; d <= 29; d++) {
    eng.advance(1, 0.02);
    assert.ok(near(eng.state.get("cells"), 10 * d, 1e-6),
      `day ${d}: nothing may leave yet, held ${eng.state.get("cells")}`);
  }
  eng.advance(1, 0.02);
  assert.ok(near(eng.state.get("cells"), 300, 1e-6), "full at T");
  eng.advance(200, 0.02);
  assert.ok(near(eng.state.get("cells"), 300, 1e-6), "and holds: in equals out");
});

test("conveyor: substep size does not change the answer", () => {
  const read = sub => {
    const { model } = ok(CONV());
    const eng = new S.Engine(model);
    for (let d = 0; d < 200; d++) eng.advance(1, sub);
    return eng.state.get("cells");
  };
  // a remainder substep (1 / 0.03 is not whole) must not leak mass either
  for (const sub of [0.05, 0.03, 0.01]) assert.ok(near(read(sub), 45, 1e-6),
    `sub=${sub} gave ${read(sub)}`);
});

test("conveyor: an event scales every cohort alike and leaves their ages intact", () => {
  // phlebotomy draws blood of all ages. What is left must still finish its 120
  // days on the ORIGINAL schedule, not restart the clock.
  const { model } = ok(`
node cells : range(0, 80), init(45), transit(120) @ bucket(fill = water)
external spleen
cells -> spleen : expire()
event draw : cells <= 40 : cells -= 10`);
  const eng = new S.Engine(model);
  const at = {};
  for (let d = 1; d <= 120; d++) { eng.advance(1, 0.02); at[d] = eng.state.get("cells"); }
  // the draw lands when the drain crosses 40, around day 13
  assert.ok(at[30] < 33.75 - 6, `the draw happened: day 30 holds ${at[30].toFixed(3)}, undisturbed is 33.75`);
  // AGES SURVIVE IT. Taking a share of every cohort leaves the schedule alone, so
  // what remains is still aimed at zero on day 120 — a straight line through it.
  // The ratio below is that line's slope, and it must not change after the draw,
  // whatever substep the event happened to fire on.
  const slope = d => at[d] / (120 - d);
  assert.ok(near(slope(30), slope(60), 1e-6), `linear: ${slope(30)} vs ${slope(60)}`);
  assert.ok(near(slope(60), slope(90), 1e-6), `linear: ${slope(60)} vs ${slope(90)}`);
  assert.ok(near(at[120], 0, 1e-6),
    `empty at exactly T, not T shifted by the draw: ${at[120]}`);
});

test("conveyor: mass is conserved — what went in came out, to the last drop", () => {
  const { model } = ok(`
node cells : range(0, 500), init(0), transit(40) @ bucket(fill = dots)
node gone  : range(0, 5000), init(0) @ bucket(fill = water)
external src
src   -> cells : constant(c = 7)
cells -> gone  : expire()`);
  const eng = new S.Engine(model);
  eng.advance(300, 0.02);
  const held = eng.state.get("cells"), out = eng.state.get("gone");
  assert.ok(near(held + out, 7 * 300, 1e-3),
    `in 2100, accounted ${(held + out).toFixed(4)} (held ${held.toFixed(3)} + out ${out.toFixed(3)})`);
});

test("conveyor: the language refuses the two ways to misuse it", () => {
  const bad = src => {
    const r = S.parseModel(src);
    assert.ok(r.errors.length > 0, "expected a parse error for:\n" + src);
    return r.errors.map(e => e.msg).join(" | ");
  };
  // expire() needs a conveyor to discharge
  assert.match(bad(`
node plain : range(0, 10), init(5) @ bucket
external out
plain -> out : expire()`), /must be a node with transit/);
  // a conveyor empties by age, so a rate law on its outflow is a contradiction
  assert.match(bad(`
node c : range(0, 10), init(5), transit(9) @ bucket
external out
c -> out : proportional(of = c, k = 0.1)`), /must be expire\(\)/);
  // and something has to collect what finishes ageing
  assert.match(bad(`
node c : range(0, 10), init(5), transit(9) @ bucket`), /no expire\(\) outflow/);
  // transit must be a positive time
  assert.ok(S.parseModel(`node c : range(0, 10), init(5), transit(0) @ bucket`).errors.length > 0);
});

test("red-cell-cohort: the echo is real, and the memoryless edge cannot produce it", () => {
  // The file's whole claim. A cohort over-produced to fix an anemia dies all at
  // once one lifespan later, so the recovery rings at the period of a red cell's
  // life. Swap the conveyor back for proportional(k = 1/120) and it goes flat.
  const src = fs.readFileSync(path.join(DIR, "red-cell-cohort.strombild"), "utf8");
  const trace = s => {
    const { model } = ok(s);
    const eng = new S.Engine(model);
    const out = [];
    for (let d = 1; d <= 800; d++) { eng.advance(1, 0.02); out.push(eng.state.get("red_cells")); }
    return out;
  };
  const turns = a => {
    let n = 0;
    for (let i = 1; i < a.length - 1; i++)
      if ((a[i] > a[i - 1] && a[i] > a[i + 1]) || (a[i] < a[i - 1] && a[i] < a[i + 1])) n++;
    return n;
  };
  const coh = trace(src);
  assert.ok(turns(coh) >= 8, `the cohort model rings, saw ${turns(coh)} turning points`);
  // peaks land one red-cell lifespan apart, and the ring damps rather than grows
  assert.ok(near(coh[119], 47.05, 0.1), `first echo peak at day 120: ${coh[119].toFixed(2)}`);
  assert.ok(near(coh[239], 46.95, 0.1), `second at day 240: ${coh[239].toFixed(2)}`);
  assert.ok(coh[239] < coh[119] && coh[490] < coh[239], "amplitude decays");

  const mem = trace(src
    .replace(", transit(120)", "")
    .replace("red_cells   -> spleen      : expire()",
             "red_cells   -> spleen      : proportional(of = red_cells, k = 0.00833)"));
  assert.equal(turns(mem), 0, "the memoryless edge gives a flat line — no echo at any parameter");
  assert.ok(near(mem[119], mem[799], 5e-3), "and it is settled well before the first echo would land");
});

/* ---------------------------------------------------------------------
 * MG25 — a disputed claim turned into a measurable consequence.
 * ------------------------------------------------------------------- */
const MG = fs.readFileSync(path.join(DIR, "mg25-dial.strombild"), "utf8");
const DIET = "adjust(of = mg25, target = 0.10, k = 0.0333)";
// the two constants that carry the claim move together: k = E/0.9, c = 1 - 0.1E/0.9
const claim = (src, E) => src
  .replace("constant(c = 0.82222222)", `constant(c = ${(1 - 0.1 * E / 0.9).toFixed(10)})`)
  .replace("proportional(of = mg25, k = 1.77777778)", `proportional(of = mg25, k = ${(E / 0.9).toFixed(10)})`);
const diet = (src, f) => src.replace(DIET, `adjust(of = mg25, target = ${f}, k = 0.0333)`);
function mgRun(src, { days = 3000 } = {}) {
  const { model } = ok(src);
  const eng = new S.Engine(model);
  eng.advance(days, 0.02);
  return { hct: eng.state.get("red_cells"), atp: eng.state.get("atp"), mg: eng.state.get("mg25") };
}

test("mg25: the ATP index is normalised — exactly 1.0 at natural abundance", () => {
  // if this drifts, every hematocrit number in the header is measuring the
  // normalisation rather than the isotope effect.
  const r = mgRun(MG);
  assert.ok(near(r.mg, 0.10, 1e-6), `marrow tracks the diet: ${r.mg}`);
  assert.ok(near(r.atp, 1.0, 1e-6), `atp index at natural abundance: ${r.atp}`);
  assert.ok(near(r.hct, 45.400, 0.01), `and the loop is unchanged from erythropoiesis: ${r.hct.toFixed(3)}`);
  // the normalisation has to hold for ANY claim size, or the dial is not a dial
  for (const E of [0.5, 1.6, 5.0]) {
    const b = mgRun(claim(MG, E));
    assert.ok(near(b.atp, 1.0, 1e-6), `E=${E} still reads 1.0 at natural abundance: ${b.atp}`);
    assert.ok(near(b.hct, 45.400, 0.01), `E=${E} baseline hematocrit unmoved: ${b.hct.toFixed(3)}`);
  }
});

test("mg25: granting the claim in full, DIET cannot reach the noise floor of a hematocrit", () => {
  // The file's load-bearing result. A hematocrit is reproducible to about 0.5
  // points; biological Mg fractionation is per-mil. Even an absurd 1% dietary
  // shift stays two orders of magnitude under the instrument.
  const base = mgRun(MG).hct;
  const generous = mgRun(diet(MG, 0.1003)).hct;   // 3 per mil — more than biology does
  const absurd   = mgRun(diet(MG, 0.101)).hct;    // 1 percent — not reachable at all
  assert.ok(near(generous - base, 0.003, 0.001), `3 per mil moves +${(generous - base).toFixed(4)}`);
  assert.ok(near(absurd - base, 0.010, 0.002), `1 percent moves +${(absurd - base).toFixed(4)}`);
  assert.ok(generous - base < 0.5 / 100, "and that is far below what a hematocrit can resolve");
});

test("mg25: the same claim DOES predict a measurable effect from an enriched supplement", () => {
  // The honest other half: the arithmetic that kills the diet keeps the real
  // experiment alive, and names its dose.
  const base = mgRun(MG).hct;
  const e20 = mgRun(diet(MG, 0.20)).hct, e50 = mgRun(diet(MG, 0.50)).hct, e90 = mgRun(diet(MG, 0.90)).hct;
  assert.ok(near(e20 - base, 0.92, 0.05), `20% enriched: +${(e20 - base).toFixed(3)}`);
  assert.ok(near(e50 - base, 3.03, 0.05), `50% enriched: +${(e50 - base).toFixed(3)}`);
  assert.ok(near(e90 - base, 5.05, 0.05), `90% enriched: +${(e90 - base).toFixed(3)}`);
  assert.ok(e20 - base > 0.5, "20% clears the measurement floor — this is the experiment to run");
});

test("mg25: to make DIET matter the claim must grow about a thousandfold", () => {
  for (const [E, want] of [[1.6, 0.003], [16, 0.030], [160, 0.291], [1600, 2.407]]) {
    const src = claim(MG, E);
    const d = mgRun(diet(src, 0.1003)).hct - mgRun(src).hct;
    assert.ok(near(d, want, Math.max(0.002, want * 0.05)),
      `E=${E}: diet moves ${d.toFixed(5)}, expected about ${want}`);
  }
});

test("mg25: the ringing is the lifespan's, not the isotope's", () => {
  // Turn the supplement on and the hematocrit overshoots and rings at the period
  // of a red cell's life. Swap the conveyor out and the ringing goes, while the
  // endpoint stays — so the harmonic belongs to transit(120), not to 25Mg.
  const trace = src => {
    const { model } = ok(src);
    const eng = new S.Engine(model);
    const out = [];
    for (let d = 1; d <= 900; d++) { eng.advance(1, 0.02); out.push(eng.state.get("red_cells")); }
    return out;
  };
  const turns = a => {
    let n = 0;
    for (let i = 1; i < a.length - 1; i++)
      if ((a[i] > a[i - 1] && a[i] > a[i + 1]) || (a[i] < a[i - 1] && a[i] < a[i + 1])) n++;
    return n;
  };
  const supp = diet(MG, 0.50);
  const coh = trace(supp);
  const mem = trace(supp
    .replace(", transit(120)", "")
    .replace("red_cells   -> spleen      : expire()",
             "red_cells   -> spleen      : proportional(of = red_cells, k = 0.00833)"));
  assert.ok(turns(coh) >= 8, `the conveyor rings: ${turns(coh)} turning points`);
  assert.equal(turns(mem), 0, "the memoryless stock climbs smoothly: no harmonic at all");
  // same destination, different journey — which is the whole point
  assert.ok(near(coh[899 - 1], mem[899 - 1], 0.25),
    `both land together: ${coh[898].toFixed(3)} vs ${mem[898].toFixed(3)}`);
  // and the first overshoot lands one red-cell lifespan in
  const firstPeak = coh.findIndex((v, i) => i > 0 && i < coh.length - 1 && v > coh[i - 1] && v > coh[i + 1]) + 1;
  assert.ok(Math.abs(firstPeak - 120) <= 5, `first peak at day ${firstPeak}, want ~120`);
});
