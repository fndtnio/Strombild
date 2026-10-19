/* =====================================================================
 * STROMBILD v0.1 — language core (pure: parser + engine + layout)
 * No DOM, no canvas. Runs in the browser (window.Strombild) and in Node
 * (module.exports) so the same code is exercised by the app and the tests.
 * ===================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Strombild = api;
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

/* ---------------------------------------------------------------------
 * Vocabulary (closed sets — extended only when a real model forces it)
 * ------------------------------------------------------------------- */
const RATE_LAWS = {
  // name -> { required:[params], reads: needs an 'of' node?, readsDest: reads its
  //           destination's headroom? }
  constant:     { required: ["c"],             reads: false },
  proportional: { required: ["k"],             reads: true  },
  hill:         { required: ["max", "k", "n"], reads: true  },
  // the inhibitory Hill: max * k^n / (k^n + of^n). Full at of = 0, half at of = k,
  // falling to 0 as `of` grows. The shape of a production REPRESSED by what it
  // produces — the kidney's EPO against the red cells it causes. Forced by
  // erythropoiesis: no existing law decreases with the node it reads.
  repress:      { required: ["max", "k", "n"], reads: true  },
  // soft backpressure: proportional to the source, but throttled as the
  // *destination* fills — k * of * (room left in dest). Flow falls to 0 at a
  // full destination, so the queue backs up in the source instead of mass
  // leaking at the clamp. Capacity is the destination's own range (no new param).
  gated:        { required: ["k"],             reads: true, readsDest: true },
  // negative feedback toward a setpoint: k * (target - of). Positive (a top-up)
  // when `of` is below target, negative (a correction) when above. The control
  // primitive — an ordering rule that closes the loop on a goal, not a level.
  adjust:       { required: ["target", "k"],   reads: true  },
  // rate as the PRODUCT of two nodes: k * of * by. The first flow whose rate reads
  // TWO stocks — for a quantity that is genuinely two things multiplied at once
  // (cardiac output = heart-rate × stroke-volume; a mass-action-like coupling on a
  // transport edge). `of` defaults to the source; `by` is the second factor, a node.
  // Both are reads, so each draws its own influence arrow. (Reactions' mass_action
  // multiplies *consumed* inputs; this multiplies two nodes without consuming either.)
  product:      { required: ["by", "k"],       reads: true, readsBy: true },
  // the discharge of a CONVEYOR (a node with transit(T)): the flow is whatever
  // finished ageing this substep, so it takes no parameters — the queue sets it.
  // Forced by red-cell lifespan: `proportional` spreads a "120-day life" over an
  // exponential whose most likely age at death is zero, and no chain of ordinary
  // stocks can stand in, because no rate law can read a sum (see transit below).
  expire:       { required: [],                reads: false, fromTransit: true },
};
// Reaction rate laws live on a pathway, not an edge: their rate reads ALL the
// reaction's inputs at once (which an edge, seeing one node via `of`, cannot).
const REACTION_LAWS = {
  // name -> { required:[params] }   ('of' is implicit: the reaction's inputs)
  limiting:    { required: ["k"] },   // k * min(input / coeff)  — the bottleneck
  mass_action: { required: ["k"] },   // k * Π input^coeff        — chemistry
};
const NODE_VISUALS = new Set(["bucket", "box"]);   // bucket = tapered pail, box = straight crate
const EDGE_VISUALS = new Set(["pipe", "rotor"]);   // pipe = flow channel, rotor = flux drawn as a spinning rotor (RPM ∝ rate)
const FILL_KINDS   = new Set(["water", "dots", "squares"]);   // fluid, round units, stacked square units
// Events: a guard crossing fires discrete assignments. Flows ooze; events snap.
const COMPARATORS  = new Set([">=", "<=", "==", ">", "<"]);   // guard operators
const ASSIGN_OPS   = new Set(["=", "+=", "-="]);              // action operators

/* ---------------------------------------------------------------------
 * Small parsing helpers
 * ------------------------------------------------------------------- */
function isNumber(tok) { return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok.trim()); }

// numbers -> floats; everything else stays a string (node references)
function parseValue(tok) { tok = tok.trim(); return isNumber(tok) ? parseFloat(tok) : tok; }

// split `s` on `sep`, but only at paren-depth 0
function splitTop(s, sep) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// separate a statement into head + its ':' / '@' channels (markers count
// only at paren-depth 0, so range(0, 50) and hill(...) are safe)
function splitChannels(line) {
  const ch = { ":": null, "@": null };
  let head = "", cur = "", marker = null, depth = 0;
  for (const c of line) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (depth === 0 && (c === ":" || c === "@")) {
      if (marker === null) head = cur; else ch[marker] = cur.trim();
      marker = c; cur = "";
    } else cur += c;
  }
  if (marker === null) head = cur; else ch[marker] = cur.trim();
  return { head: head.trim(), channels: ch };
}

// parse `name(a = 1, b = 2)` or `range(0, 50)` -> { name, params, args }
function parseCall(str) {
  const m = str.match(/^([A-Za-z_]\w*)\s*(?:\((.*)\))?\s*$/s);
  if (!m) return { name: null, params: {}, args: [], bad: str };
  const params = {}, args = [];
  if (m[2] != null && m[2].trim() !== "") {
    for (const part of splitTop(m[2], ",")) {
      if (part.trim() === "") continue;
      const eq = part.indexOf("=");
      if (eq >= 0) params[part.slice(0, eq).trim()] = parseValue(part.slice(eq + 1));
      else args.push(parseValue(part));
    }
  }
  return { name: m[1], params, args };
}

/* ---------------------------------------------------------------------
 * PARSER — tolerant; collects {errors, warnings} with line numbers.
 * ------------------------------------------------------------------- */
function parseModel(src) {
  const model = {
    nodes: new Map(),      // name -> { name, range:[min,max]|null, init:num|null, visual, fill }
    externals: new Map(),  // name -> { name, role:'source'|'sink'|'both' }
    edges: [],             // { id, src, dest, rate:{law,params}, visual, line }
    pathways: new Map(),   // name -> {kind:"selection",refs} | {kind:"reaction",inputs,outputs,rate}
    events: [],            // { name, guard:{node,op,rhs}, actions:[{node,op,value}], line }
    order: [],             // declaration order (layout tie-break)
  };
  const errors = [], warnings = [];
  const err  = (ln, msg) => errors.push({ line: ln, msg });
  const warn = (ln, msg) => warnings.push({ line: ln, msg });

  src.split("\n").forEach((raw, i) => {
    const ln = i + 1;
    const text = raw.split("#")[0].trim();
    if (text === "") return;

    const head0 = splitChannels(text).head;
    if (head0.includes("->")) return parseEdge(text, ln);

    const first = text.split(/\s+/)[0];
    if (first === "node")     return parseNode(text, ln);
    if (first === "external") return parseExternal(text, ln);
    if (first === "pathway")  return parsePathway(text, ln);
    if (first === "event")    return parseEvent(text, ln);

    err(ln, `unrecognized statement: "${text.length > 40 ? text.slice(0, 40) + "…" : text}"`);
  });

  function parseNode(text, ln) {
    const { head, channels } = splitChannels(text);
    const name = head.replace(/^node\s+/, "").trim();
    if (!name) return err(ln, "node has no name");
    if (model.nodes.has(name)) warn(ln, `node "${name}" redeclared`);

    let range = null, visual = "bucket", fill = "water", init = null, threshold = null, transit = null;
    if (channels[":"]) {
      // the definition channel is a comma-list of clauses: range(...), init(...)
      for (const raw of splitTop(channels[":"], ",")) {
        const clause = raw.trim();
        if (clause === "") continue;
        const call = parseCall(clause);
        if (call.name === "range") {
          if (call.args.length >= 2) range = [call.args[0], call.args[1]];
          else err(ln, `range needs (min, max); got "${clause}"`);
        } else if (call.name === "init") {
          const v = call.args.length ? call.args[0] : call.params.value;
          if (typeof v === "number") init = v;
          else err(ln, `init needs a number; got "${clause}"`);
        } else if (call.name === "transit") {
          const v = call.args.length ? call.args[0] : call.params.value;
          if (typeof v === "number" && v > 0) transit = v;
          else err(ln, `transit needs a positive number of time units; got "${clause}"`);
        } else {
          err(ln, `unknown node definition "${call.name}" (expected range, init or transit)`);
        }
      }
    }
    if (channels["@"]) {
      const call = parseCall(channels["@"]);
      if (!NODE_VISUALS.has(call.name)) {
        warn(ln, `unknown node visual "${call.name}", drawing as bucket`);
      } else {
        visual = call.name;
        if (call.params.fill != null) {
          if (FILL_KINDS.has(call.params.fill)) fill = call.params.fill;
          else warn(ln, `unknown fill "${call.params.fill}", using water`);
        }
        if (call.params.threshold != null) {
          const t = call.params.threshold;
          if (t === "auto" || typeof t === "number") threshold = t;
          else warn(ln, `threshold must be a number or 'auto', got "${t}"`);
        }
      }
    }
    if (init != null && range && (init < range[0] || init > range[1]))
      warn(ln, `init ${init} is outside range(${range[0]}, ${range[1]}) — will be clamped`);

    model.nodes.set(name, { name, range, init, visual, fill, threshold, transit });
    model.order.push(name);
  }

  function parseExternal(text, ln) {
    const name = text.replace(/^external\s+/, "").trim();
    if (!name) return err(ln, "external has no name");
    if (!model.externals.has(name)) model.externals.set(name, { name, role: null });
    if (!model.order.includes(name)) model.order.push(name);
  }

  function parseEdge(text, ln) {
    const { head, channels } = splitChannels(text);
    const ends = head.split("->");
    if (ends.length !== 2) return err(ln, `edge needs exactly one '->', got "${head}"`);
    const src = ends[0].trim(), dest = ends[1].trim();
    if (!src || !dest) return err(ln, `edge endpoint missing in "${head}"`);

    let rate = null;
    if (!channels[":"]) {
      err(ln, `edge ${src}->${dest} has no rate law (':' channel)`);
    } else {
      const call = parseCall(channels[":"]);
      const spec = RATE_LAWS[call.name];
      if (!spec) {
        err(ln, `unknown rate law "${call.name}" on ${src}->${dest}`);
      } else {
        for (const p of spec.required)
          if (call.params[p] == null) err(ln, `${call.name}(...) missing param "${p}"`);
        rate = { law: call.name, params: call.params };
      }
    }
    let visual = "pipe";
    if (channels["@"]) {
      const call = parseCall(channels["@"]);
      if (!EDGE_VISUALS.has(call.name)) warn(ln, `unknown edge visual "${call.name}", drawing as pipe`);
      else visual = call.name;
    }
    model.edges.push({ id: `${src}->${dest}`, src, dest, rate, visual, line: ln });
  }

  function parsePathway(text, ln) {
    // `pathway <name> : <body>` — split off name on the first top-level ':'.
    // A reaction adds a second top-level ':' separating equation from rate law:
    //   pathway assemble : A + B -> C : limiting(k = 0.5)
    const segs = splitTop(text.replace(/^pathway\s+/, ""), ":");
    const name = (segs.shift() || "").trim();
    if (!name) return err(ln, "pathway has no name");
    const body = segs.map(s => s.trim());

    if (body.length >= 2) return parseReaction(name, body[0], body[1], ln);
    const only = body[0] || "";
    if (only.includes("+"))
      return err(ln, `reaction pathway "${name}" needs a rate law: ${name} : A + B -> C : limiting(k = ...)`);

    // selection: a comma-list of edge references
    const refs = only.split(",").map(s => s.replace(/\s+/g, "")).filter(Boolean);
    if (!refs.length) warn(ln, `pathway "${name}" lists no edges`);
    model.pathways.set(name, { kind: "selection", refs, line: ln });
  }

  // one term of a reaction equation: "supplyA" or "2 supplyA" -> {node, coeff}
  function parseTerms(side, name, ln) {
    const out = [];
    for (const raw of splitTop(side, "+")) {
      const t = raw.trim();
      if (t === "") continue;
      const m = t.match(/^(\d+\.?\d*\s+)?([A-Za-z_]\w*)$/);
      if (!m) { err(ln, `reaction "${name}": bad term "${t}" (want "node" or "2 node")`); continue; }
      out.push({ node: m[2], coeff: m[1] ? parseFloat(m[1]) : 1 });
    }
    return out;
  }

  function parseReaction(name, eqStr, lawStr, ln) {
    const sides = eqStr.split("->");
    if (sides.length !== 2) return err(ln, `reaction "${name}" needs exactly one '->', got "${eqStr}"`);
    const inputs  = parseTerms(sides[0], name, ln);
    const outputs = parseTerms(sides[1], name, ln);
    if (!inputs.length)  err(ln, `reaction "${name}" has no inputs`);
    if (!outputs.length) err(ln, `reaction "${name}" has no outputs`);

    // the law may carry a trailing visual: `limiting(k = 0.5) @ rotor`
    const lawSegs = splitTop(lawStr, "@").map(s => s.trim());
    const call = parseCall(lawSegs[0]);
    const spec = REACTION_LAWS[call.name];
    let rate = null;
    if (!spec) err(ln, `unknown reaction rate law "${call.name}" on "${name}" (try limiting or mass_action)`);
    else {
      for (const p of spec.required)
        if (call.params[p] == null) err(ln, `${call.name}(...) missing param "${p}" on reaction "${name}"`);
      rate = { law: call.name, params: call.params };
    }
    let visual = "pipe";
    if (lawSegs[1]) {
      const vcall = parseCall(lawSegs[1]);
      if (!EDGE_VISUALS.has(vcall.name)) warn(ln, `unknown reaction visual "${vcall.name}", drawing as pipes`);
      else visual = vcall.name;
    }
    model.pathways.set(name, { kind: "reaction", inputs, outputs, rate, visual, line: ln });
  }

  function parseEvent(text, ln) {
    // `event <name> : <guard> : <action>, ...` — same two-colon idiom as a
    // reaction pathway: the second top-level ':' splits guard from action.
    const segs = splitTop(text.replace(/^event\s+/, ""), ":");
    const name = (segs.shift() || "").trim();
    if (!name) return err(ln, "event has no name");
    if (segs.length !== 2)
      return err(ln, `event "${name}" needs <guard> : <action> — e.g. ${name} : widget >= 20 : widget = 0, shipped += 20`);

    // guard: one or more `<node> <comparator> <number>` clauses, ANDed with `&`
    // (e.g. `cdk >= 10 & dead == 0` — fire only while the cell is still alive).
    const clauses = [];
    let guardOk = true;
    for (const raw of segs[0].split("&")) {
      const part = raw.trim();
      if (part === "") continue;
      const gm = part.match(/^([A-Za-z_]\w*)\s*(>=|<=|==|>|<)\s*(.+)$/);
      if (!gm) { err(ln, `event "${name}": bad guard clause "${part}" (want "node >= 20")`); guardOk = false; continue; }
      const rhs = parseValue(gm[3]);
      if (typeof rhs !== "number") { err(ln, `event "${name}": guard threshold must be a number, got "${gm[3].trim()}"`); guardOk = false; continue; }
      if (!model.nodes.has(gm[1])) warn(ln, `event "${name}" watches "${gm[1]}", which is not a node`);
      clauses.push({ node: gm[1], op: gm[2], rhs });
    }
    if (guardOk && !clauses.length) { err(ln, `event "${name}": guard has no clauses`); guardOk = false; }
    const guard = guardOk ? clauses : null;

    // actions: comma-list of <node> <assign-op> <number>
    const actions = [];
    for (const raw of segs[1].split(",")) {
      const t = raw.trim();
      if (t === "") continue;
      const am = t.match(/^([A-Za-z_]\w*)\s*(\+=|-=|=)\s*(.+)$/);
      if (!am) { err(ln, `event "${name}": bad action "${t}" (want "node = 0" or "node += 1")`); continue; }
      const v = parseValue(am[3]);
      if (typeof v !== "number") { err(ln, `event "${name}": action value must be a number, got "${am[3].trim()}"`); continue; }
      if (!model.nodes.has(am[1])) warn(ln, `event "${name}" assigns to "${am[1]}", which is not a node`);
      actions.push({ node: am[1], op: am[2], value: v });
    }
    if (!actions.length) err(ln, `event "${name}" has no actions`);

    if (guard && actions.length) model.events.push({ name, guard, actions, line: ln });
  }

  // --- resolution: implicit externals + role inference ----------------
  const touched = new Map();
  for (const e of model.edges) {
    for (const [name, dir] of [[e.src, "out"], [e.dest, "in"]]) {
      if (!touched.has(name)) touched.set(name, { in: 0, out: 0 });
      touched.get(name)[dir]++;
    }
  }
  for (const [name, t] of touched) {
    if (model.nodes.has(name)) continue;
    if (!model.externals.has(name)) {
      model.externals.set(name, { name, role: null });
      if (!model.order.includes(name)) model.order.push(name);
      warn(model.edges.find(e => e.src === name || e.dest === name).line,
           `"${name}" used in an edge but never declared — treating as external`);
    }
    const ext = model.externals.get(name);
    ext.role = t.in && t.out ? "both" : t.out ? "source" : "sink";
  }
  for (const [name, ext] of model.externals) {
    if (ext.role) continue;
    const t = touched.get(name);
    ext.role = !t ? "source" : (t.in && t.out ? "both" : t.out ? "source" : "sink");
  }

  // reaction participants: an undeclared one becomes an implicit external
  // (an input is a source — it feeds the reaction; an output is a sink).
  for (const [pname, p] of model.pathways) {
    if (p.kind !== "reaction") continue;
    const mark = (nm, want) => {
      if (model.nodes.has(nm)) return;
      if (!model.externals.has(nm)) {
        model.externals.set(nm, { name: nm, role: null });
        if (!model.order.includes(nm)) model.order.push(nm);
        warn(p.line, `"${nm}" used in reaction "${pname}" but never declared — treating as external`);
      }
      const ext = model.externals.get(nm);
      ext.role = ext.role && ext.role !== want ? "both" : want;
    };
    for (const i of p.inputs)  mark(i.node, "source");
    for (const o of p.outputs) mark(o.node, "sink");
  }

  for (const [pname, p] of model.pathways) {
    if (p.kind !== "selection") continue;
    for (const ref of p.refs)
      if (!model.edges.some(e => e.id.replace(/\s+/g, "") === ref))
        warn(0, `pathway "${pname}" references edge "${ref}" that doesn't exist`);
  }

  // a backpressure law (readsDest) measures headroom against its destination's
  // capacity — so that destination must be a node with a declared range.
  for (const e of model.edges) {
    if (!e.rate) continue;
    const spec = RATE_LAWS[e.rate.law];
    if (!spec || !spec.readsDest) continue;
    const d = model.nodes.get(e.dest);
    if (!d)
      err(e.line, `${e.rate.law}(...) on ${e.src}->${e.dest}: "${e.dest}" must be a node with a declared range — backpressure needs a capacity`);
    else if (!d.range)
      err(e.line, `${e.rate.law}(...) on ${e.src}->${e.dest}: "${e.dest}" needs range(min, max) — backpressure needs a capacity`);
  }

  // a CONVEYOR (transit) discharges by age, so its only outflow is expire(), and
  // expire() means nothing anywhere else. Checked both ways.
  for (const e of model.edges) {
    if (!e.rate) continue;
    const src = model.nodes.get(e.src);
    if (e.rate.law === "expire" && (!src || src.transit == null))
      err(e.line, `expire() on ${e.src}->${e.dest}: "${e.src}" must be a node with transit(T) — only a conveyor has an age to finish`);
    if (e.rate.law !== "expire" && src && src.transit != null)
      err(e.line, `${e.rate.law}(...) on ${e.src}->${e.dest}: "${e.src}" has transit(${src.transit}), so its outflow must be expire() — a conveyor empties by age, not by rate`);
  }
  for (const [name, node] of model.nodes) {
    if (node.transit == null) continue;
    const outs = model.edges.filter(e => e.src === name && e.rate && e.rate.law === "expire");
    if (outs.length === 0)
      err(0, `node "${name}" has transit(${node.transit}) but no expire() outflow — nothing collects what finishes ageing`);
    else if (outs.length > 1)
      err(0, `node "${name}" has ${outs.length} expire() outflows — a conveyor discharges once`);
  }

  return { model, errors, warnings };
}

/* ---------------------------------------------------------------------
 * ENGINE — forward Euler over the active edge set.
 * ------------------------------------------------------------------- */
class Engine {
  constructor(model) {
    this.model = model;
    this.t = 0;
    this.state = new Map();
    this.lastFlows = new Map();
    this.lastReactionRates = new Map();   // reaction name -> last shared rate
    this.eventState = new Map();          // event name -> guard was true last substep (edge-trigger)
    this.lastEventFires = [];             // events that fired on the most recent substep
    this.eventFires = new Map();          // event name -> cumulative fire count (for the renderer's flash)
    this.lastNet = new Map();
    this.observedMax = new Map();
    this.pathway = null;
    this.reset();
  }

  reset() {
    this.t = 0;
    for (const [name, node] of this.model.nodes) {
      let v0 = node.init != null ? node.init : (node.range ? node.range[0] : 0);
      if (node.range) v0 = Math.max(node.range[0], Math.min(node.range[1], v0));
      else v0 = Math.max(0, v0);
      this.state.set(name, v0);
      this.observedMax.set(name, node.range ? node.range[1] : Math.max(10, Math.abs(v0)));
    }
    // CONVEYORS. A transit node's contents carry an age, held as slabs of uniform
    // density over a window of CREATION time: {t0, t1, amt}. Ages are never stored
    // (age = now - creation) and a bulk removal moves `scale` instead of every
    // slab, so a substep costs O(1) however long the queue is. The node's value
    // stays one number — scale * raw — which is why `repress(of = red_cells)` and
    // every other law keep reading it with no idea it has an inside.
    this.conveyors = new Map();
    this.expiring = new Map();
    for (const [name, node] of this.model.nodes) {
      if (node.transit == null) continue;
      const v0 = this.state.get(name);
      // the steady state is a flat age distribution: one slab created evenly over
      // the last T, so it discharges evenly over the next T. Loading it all at
      // age 0 instead would fire the whole stock back out as a pulse at t = T.
      this.conveyors.set(name, {
        T: node.transit,
        slabs: v0 > 0 ? [{ t0: -node.transit, t1: 0, amt: v0 }] : [],
        head: 0, raw: v0, scale: 1,
      });
    }
    this.lastFlows.clear();
    this.lastReactionRates.clear();
    // arm each event from its guard at the initial state, so a model that
    // starts above threshold doesn't fire spuriously on the first substep.
    this.eventState.clear();
    this.eventFires.clear();
    for (const ev of this.model.events) { this.eventState.set(ev.name, this.guardTrue(ev)); this.eventFires.set(ev.name, 0); }
    this.lastEventFires = [];
    this.lastNet = new Map([...this.model.nodes.keys()].map(n => [n, 0]));
  }

  setPathway(name) { this.pathway = name || null; }

  activeEdges() {
    if (!this.pathway || !this.model.pathways.has(this.pathway)) return this.model.edges;
    const p = this.model.pathways.get(this.pathway);
    if (p.kind === "reaction") return this.model.edges;   // transport (supply) stays on
    const out = [];
    for (const ref of p.refs) {
      const e = this.model.edges.find(e => e.id.replace(/\s+/g, "") === ref);
      if (e) out.push(e);
    }
    return out;
  }

  // which reactions run: none selected -> ALL of them (they compete for shared
  // stocks); a reaction selected -> just that one; a selection pathway -> none.
  activeReactions() {
    const all = [];
    for (const [name, p] of this.model.pathways)
      if (p.kind === "reaction") all.push({ name, ...p });
    if (!this.pathway) return all;
    const p = this.model.pathways.get(this.pathway);
    if (p && p.kind === "reaction") return [{ name: this.pathway, ...p }];
    return [];
  }

  // the single shared rate of a reaction, reading all its inputs
  reactionRate(rx) {
    if (!rx.rate) return 0;
    const k = +rx.rate.params.k;
    const val = nm => (this.state.has(nm) ? this.state.get(nm) : 0);
    if (rx.rate.law === "limiting") {
      let m = Infinity;
      for (const i of rx.inputs) m = Math.min(m, val(i.node) / i.coeff);
      return Math.max(0, k * m);
    }
    if (rx.rate.law === "mass_action") {
      let prod = 1;
      for (const i of rx.inputs) prod *= Math.pow(Math.max(0, val(i.node)), i.coeff);
      return k * prod;
    }
    return 0;
  }

  // --- events: discrete, edge-triggered resets -----------------------
  // a guard is a conjunction: every clause must hold for the event to fire.
  guardTrue(ev) {
    return ev.guard.every(c => {
      const v = this.state.has(c.node) ? this.state.get(c.node) : 0;
      const r = c.rhs;
      switch (c.op) {
        case ">=": return v >= r;
        case "<=": return v <= r;
        case ">":  return v >  r;
        case "<":  return v <  r;
        case "==": return v === r;
        default:   return false;
      }
    });
  }

  applyAction(a) {
    const node = this.model.nodes.get(a.node);
    if (!node) return;
    let v = this.state.has(a.node) ? this.state.get(a.node) : 0;
    if (a.op === "=")  v = a.value;
    else if (a.op === "+=") v += a.value;
    else if (a.op === "-=") v -= a.value;
    if (node.range) v = Math.max(node.range[0], Math.min(node.range[1], v));
    else v = Math.max(0, v);
    if (node.transit != null) {
      // an event on a conveyor scales every cohort alike — phlebotomy draws blood
      // of all ages, it does not skim the oldest. Ages are preserved, so what is
      // left still finishes its 120 days on the original schedule.
      const c = this.conveyors.get(a.node);
      const cur = c.scale * c.raw;
      if (cur > 1e-12) c.scale *= v / cur;
      else { c.slabs = v > 0 ? [{ t0: this.t - c.T, t1: this.t, amt: v }] : []; c.head = 0; c.raw = v; c.scale = 1; }
    }
    this.state.set(a.node, v);
    this.observedMax.set(a.node, Math.max(this.observedMax.get(a.node) || 0, v));
  }

  // fire every event whose guard just crossed false -> true (rising edge),
  // applying its actions at once. Called after each integration substep.
  fireEvents() {
    this.lastEventFires = [];
    for (const ev of this.model.events) {
      const now = this.guardTrue(ev);
      const was = this.eventState.get(ev.name) || false;
      if (now && !was) {
        for (const a of ev.actions) this.applyAction(a);
        this.lastEventFires.push(ev.name);
        this.eventFires.set(ev.name, (this.eventFires.get(ev.name) || 0) + 1);
      }
      this.eventState.set(ev.name, now);
    }
  }

  // mass whose age reaches T on or before `tEnd`. `take` mutates (the real
  // discharge); otherwise it only peeks, so the rate can be read before any
  // state moves and Euler still sees one consistent start-of-step world.
  release(c, tEnd, take) {
    let out = 0, i = c.head;
    // substeps are not all the same width (advance() ends on a remainder), so
    // more than one slab can finish in a single step — walk until one is unripe.
    while (i < c.slabs.length) {
      const sl = c.slabs[i];
      const e0 = sl.t0 + c.T, e1 = sl.t1 + c.T;   // when this slab starts and finishes leaving
      if (e0 >= tEnd) break;                      // its turn has not come
      if (e1 <= tEnd) {                           // all of it is out
        out += sl.amt;
        if (take) c.raw -= sl.amt;
        i++; continue;
      }
      const m = sl.amt * (tEnd - e0) / (e1 - e0); // part of it is out
      out += m;
      if (take) { sl.amt -= m; c.raw -= m; sl.t0 = tEnd - c.T; }
      break;
    }
    if (take) {
      c.head = i;                                 // drop by moving the head, not by shifting
      if (c.head > 4096 && c.head * 2 > c.slabs.length) { c.slabs = c.slabs.slice(c.head); c.head = 0; }
    }
    return out * c.scale;
  }

  // value the rate law reads, defaulting 'of' to the edge source
  readOf(edge) {
    const ref = edge.rate.params.of != null ? edge.rate.params.of : edge.src;
    return this.state.has(ref) ? this.state.get(ref) : 0;
  }
  // read a named node reference (0 if it isn't a tracked stock) — the second factor
  readRef(ref) { return this.state.has(ref) ? this.state.get(ref) : 0; }

  flow(edge) {
    if (!edge.rate) return 0;
    const p = edge.rate.params;
    switch (edge.rate.law) {
      case "constant":     return +p.c;
      case "proportional": return p.k * this.readOf(edge);
      case "hill": {
        const x = this.readOf(edge), n = +p.n;
        return p.max * Math.pow(x, n) / (Math.pow(p.k, n) + Math.pow(x, n));
      }
      case "repress": {
        const x = Math.max(0, this.readOf(edge)), n = +p.n, kn = Math.pow(p.k, n);
        return p.max * kn / (kn + Math.pow(x, n));
      }
      case "gated": {
        // headroom in [0,1]: 1 when the destination is empty, 0 when full
        const d = this.model.nodes.get(edge.dest);
        let head = 1;
        if (d && d.range) {
          const [lo, hi] = d.range;
          const lvl = this.state.has(edge.dest) ? this.state.get(edge.dest) : 0;
          head = hi > lo ? Math.max(0, Math.min(1, (hi - lvl) / (hi - lo))) : 0;
        }
        return p.k * this.readOf(edge) * head;
      }
      case "adjust": return p.k * (p.target - this.readOf(edge));   // may be negative: a correction
      case "product": return p.k * this.readOf(edge) * this.readRef(p.by);   // k · of · by
      case "expire":  return this.expiring.get(edge.src) || 0;   // set by the queue, not by a parameter
      default: return 0;
    }
  }

  derivatives() {
    const net = new Map();
    for (const name of this.model.nodes.keys()) net.set(name, 0);
    for (const e of this.activeEdges()) {
      const f = this.flow(e);
      this.lastFlows.set(e.id, f);
      if (net.has(e.src))  net.set(e.src,  net.get(e.src)  - f);
      if (net.has(e.dest)) net.set(e.dest, net.get(e.dest) + f);
    }
    // reactions: one shared rate r drives every participant by ±coeff·r
    for (const rx of this.activeReactions()) {
      const r = this.reactionRate(rx);
      this.lastReactionRates.set(rx.name, r);
      for (const i of rx.inputs)  if (net.has(i.node)) net.set(i.node, net.get(i.node) - i.coeff * r);
      for (const o of rx.outputs) if (net.has(o.node)) net.set(o.node, net.get(o.node) + o.coeff * r);
    }
    this.lastNet = net;
    return net;
  }

  stepOnce(h) {
    // what finishes ageing in this substep is a RATE the expire() law reads, so
    // it has to be known before derivatives() runs.
    for (const [name, c] of this.conveyors)
      this.expiring.set(name, h > 1e-12 ? this.release(c, this.t + h, false) / h : 0);

    const net = this.derivatives();
    for (const [name, node] of this.model.nodes) {
      if (node.transit != null) continue;        // conveyors advance in stepConveyors
      let v = this.state.get(name) + net.get(name) * h;
      if (node.range) v = Math.max(node.range[0], Math.min(node.range[1], v));
      else v = Math.max(0, v);
      this.state.set(name, v);
      this.observedMax.set(name, Math.max(this.observedMax.get(name), v));
    }
    if (this.conveyors.size) this.stepConveyors(h);
    // events fire after the flows have moved the stocks for this substep, so a
    // guard catches its crossing the instant it happens (clean sawtooth teeth).
    if (this.model.events.length) this.fireEvents();
    this.t += h;
  }

  // discharge what has aged out, then admit this substep's inflow as a new slab.
  // A conveyor is NOT clamped to its range: its value is the mass it holds, and
  // silently clipping that would create or destroy blood.
  stepConveyors(h) {
    for (const [name, c] of this.conveyors) {
      this.release(c, this.t + h, true);
      let inflow = 0;
      for (const e of this.activeEdges())
        if (e.dest === name) inflow += (this.lastFlows.get(e.id) || 0);
      const add = inflow * h;
      if (add > 0) {
        if (c.scale < 1e-9) {                     // renormalise before precision goes
          for (let i = c.head; i < c.slabs.length; i++) c.slabs[i].amt *= c.scale;
          c.raw *= c.scale; c.scale = 1;
        }
        c.slabs.push({ t0: this.t, t1: this.t + h, amt: add / c.scale });
        c.raw += add / c.scale;
      }
      const v = Math.max(0, c.scale * c.raw);
      this.state.set(name, v);
      this.observedMax.set(name, Math.max(this.observedMax.get(name) || 0, v));
    }
  }

  // advance by `dtModel` model-time units in small honest substeps
  advance(dtModel, sub = 0.02) {
    let left = dtModel;
    while (left > 1e-9) { const h = Math.min(sub, left); this.stepOnce(h); left -= h; }
  }

  displayMax(name) {
    const node = this.model.nodes.get(name);
    if (node && node.range) return node.range[1];
    return Math.max(10, this.observedMax.get(name) * 1.25);
  }
}

/* ---------------------------------------------------------------------
 * LAYOUT — longest-path ranking -> left-to-right columns (no DOM).
 * ------------------------------------------------------------------- */
function layout(model, W, H) {
  const names = [...model.order];
  const isNode = n => model.nodes.has(n);
  // rank constraints: transport edges plus each reaction's input->output arcs
  const arcs = model.edges.map(e => [e.src, e.dest]);
  for (const [, p] of model.pathways)
    if (p.kind === "reaction")
      for (const i of p.inputs) for (const o of p.outputs) arcs.push([i.node, o.node]);
  const rank = new Map(names.map(n => [n, 0]));
  for (let it = 0; it < names.length + 1; it++) {       // bounded: tolerates cycles
    let changed = false;
    for (const [src, dest] of arcs) {
      if (!rank.has(src) || !rank.has(dest)) continue;
      const want = rank.get(src) + 1;
      if (want > rank.get(dest)) { rank.set(dest, want); changed = true; }
    }
    if (!changed) break;
  }
  const cols = new Map();
  for (const n of names) {
    const r = rank.get(n);
    if (!cols.has(r)) cols.set(r, []);
    cols.get(r).push(n);
  }
  const ranks = [...cols.keys()].sort((a, b) => a - b);
  const NODE_H = 104, NODE_W = 78;
  const padX = 70, padY = 26;
  // keep every center at least a node's half-height (+ room for labels above)
  // off the top/bottom edge, so tall buckets never clip out of the canvas.
  const vMargin = padY + NODE_H / 2 + 14;
  const usableW = Math.max(1, W - 2 * padX);
  const usableH = Math.max(1, H - 2 * vMargin);
  const pos = new Map();
  // a bucket plus the label band drawn above it — the minimum center-to-center
  // spacing within a rank, so stacked buckets never let a label land on the rim
  // of the bucket above (the crowded-column case: e.g. mito-demand's two dials).
  const MIN_ROW = NODE_H + 36;
  ranks.forEach((r, ci) => {
    const x = ranks.length === 1 ? W / 2 : padX + (usableW * ci) / (ranks.length - 1);
    const members = cols.get(r);
    const m = members.length;
    // even spread across the usable height, but never tighter than MIN_ROW;
    // when clamped the block overflows usableH, so center it (a no-op otherwise).
    const step = Math.max(m > 1 ? usableH / (m - 1) : 0, MIN_ROW);
    // center the block, but never push the top row above its safe margin: when a
    // column overflows a short canvas, clip the bottom, not the first label.
    const y0 = Math.max(vMargin, H / 2 - (step * (m - 1)) / 2);
    members.forEach((n, ri) => {
      const y = m === 1 ? H / 2 : y0 + step * ri;
      const node = isNode(n);
      pos.set(n, { x, y, w: node ? NODE_W : 60, h: node ? NODE_H : 40, rank: r, kind: node ? "node" : "external" });
    });
  });
  // event glyphs: place each near the stocks it couples (guard + actions),
  // lifted above the pipes. Keyed "event:<name>" to never collide with a node.
  (model.events || []).forEach((ev, ei) => {
    const refs = [...ev.guard.map(c => c.node), ...ev.actions.map(a => a.node)].filter(n => pos.has(n));
    if (!refs.length) return;
    let sx = 0, sy = 0;
    for (const n of refs) { const p = pos.get(n); sx += p.x; sy += p.y; }
    const x = sx / refs.length;
    const y = Math.max(vMargin, sy / refs.length - NODE_H * 0.55) + ei * 22;
    pos.set("event:" + ev.name, { x, y, w: 30, h: 30, rank: null, kind: "event", name: ev.name });
  });
  return pos;
}

/* ---------------------------------------------------------------------
 * FIT VIEW — layout never packs a rank tighter than MIN_ROW, so a crowded
 * column on a short canvas overflows by design (clip the bottom, not the
 * first label). The iron model's five sources did exactly that on a laptop.
 * This turns the overflow into a uniform scale instead: the same picture,
 * smaller, centred. Pure; the renderer applies it and inverts it for hits.
 *   { s, tx, ty }  with  screen = layout * s + (tx, ty)
 * ------------------------------------------------------------------- */
function fitView(pos, W, H) {
  let top = Infinity, bot = -Infinity, left = Infinity, right = -Infinity;
  for (const p of pos.values()) {
    // room for what is drawn outside the box: a node's label band above, an
    // event glyph's name above and guard below, a little breathing space else
    const above = p.kind === "node" ? 30 : p.kind === "event" ? 24 : 8;
    const below = p.kind === "event" ? 24 : 8;
    top = Math.min(top, p.y - p.h / 2 - above);
    bot = Math.max(bot, p.y + p.h / 2 + below);
    left = Math.min(left, p.x - p.w / 2 - 40);
    right = Math.max(right, p.x + p.w / 2 + 40);
  }
  const identity = { s: 1, tx: 0, ty: 0 };
  if (!(bot > top) || !(right > left)) return identity;
  const s = Math.min(1, H / (bot - top), W / (right - left));
  if (s >= 1) return identity;
  // scale about the content's own centre, then centre that in the canvas
  const cx = (left + right) / 2, cy = (top + bot) / 2;
  return { s, tx: W / 2 - cx * s, ty: H / 2 - cy * s };
}

/* ---------------------------------------------------------------------
 * INFLUENCES — the couplings that are NOT material flows: a rate law reading
 * a node via `of`, and an event reading its guard / writing its actions. These
 * close every feedback loop but carry no mass, so they are drawn as dashed
 * arrows, not pipes. Pure derivation from the parsed model (no new syntax).
 *   read : { kind:"read",  from:<node>, to:{edge:<id>} | {event:<name>} }
 *   write: { kind:"write", from:{event:<name>}, to:<node>, op:<assign> }
 * ------------------------------------------------------------------- */
function influences(model) {
  const out = [];
  // a rate law reading a third party (or its own destination = feedback). The
  // default `of == src` (a flow set by its own source) is the boring case and
  // is left undrawn so diagrams aren't cluttered with the obvious.
  for (const e of model.edges) {
    if (!e.rate) continue;
    const spec = RATE_LAWS[e.rate.law];
    if (!spec) continue;
    if (spec.reads) {
      const of = e.rate.params.of != null ? e.rate.params.of : e.src;
      if (of !== e.src && model.nodes.has(of))
        out.push({ kind: "read", from: of, to: { edge: e.id } });
    }
    // the product law's second factor is a second read — its own influence arrow
    if (spec.readsBy) {
      const by = e.rate.params.by;
      if (by !== e.src && model.nodes.has(by))
        out.push({ kind: "read", from: by, to: { edge: e.id } });
    }
    // backpressure: the flow reads its destination's fullness — the feedback
    // that closes the loop, drawn so the diagram shows why the pipe throttles.
    if (spec.readsDest && model.nodes.has(e.dest))
      out.push({ kind: "read", from: e.dest, to: { edge: e.id }, backpressure: true });
  }
  // events: each distinct guard node is a read; each distinct action target a write
  for (const ev of model.events) {
    const gseen = new Set();
    for (const c of ev.guard) {
      if (!model.nodes.has(c.node) || gseen.has(c.node)) continue;
      gseen.add(c.node);
      out.push({ kind: "read", from: c.node, to: { event: ev.name } });
    }
    const seen = new Set();
    for (const a of ev.actions) {
      if (!model.nodes.has(a.node) || seen.has(a.node)) continue;
      seen.add(a.node);
      out.push({ kind: "write", from: { event: ev.name }, to: a.node, op: a.op });
    }
  }
  return out;
}

/* ---------------------------------------------------------------------
 * ANALYSIS — fixed points of a stock along its own axis (the first piece
 * of "fate detection"). A 1-D slice: vary `nodeName`, hold other stocks
 * at their reset values. Exact for self-contained stocks (café, gene);
 * a slice for coupled models, which is honest enough to draw a line from.
 * ------------------------------------------------------------------- */
function equilibria(model, nodeName, pathway = null, samples = 800) {
  if (!model.nodes.has(nodeName)) return [];
  const eng = new Engine(model);
  if (pathway) eng.setPathway(pathway);
  const node = model.nodes.get(nodeName);
  const lo = node.range ? node.range[0] : 0;
  const hi = node.range ? node.range[1] : Math.max(10, eng.displayMax(nodeName));
  if (hi <= lo) return [];

  // net rate of change of this stock when it sits at level L
  const netAt = (L) => {
    const saved = eng.state.get(nodeName);
    eng.state.set(nodeName, L);
    const n = eng.derivatives().get(nodeName);
    eng.state.set(nodeName, saved);
    return n;
  };

  const eps = 1e-9;   // deadzone only absorbs true float-zero, not small real rates
  const step = (hi - lo) / samples;
  const sign = v => (v > eps ? 1 : v < -eps ? -1 : 0);
  // a fixed point is stable iff net is decreasing through it (slope < 0)
  const stableAt = L => netAt(L - step) > netAt(L + step);
  const fps = [];

  // lower boundary (e.g. an empty/off stock at 0): a fixed point if the flow
  // just inside points back toward it
  let lastSign = sign(netAt(lo + step * 0.5));
  if (lastSign < 0) fps.push({ level: lo, stable: true, boundary: true });

  // interior crossings, classified by slope (robust to samples landing on 0)
  for (let i = 1; i <= samples; i++) {
    const s = sign(netAt(lo + i * step));
    if (s !== 0 && lastSign !== 0 && s !== lastSign) {
      const Lc = lo + (i - 0.5) * step;
      fps.push({ level: Lc, stable: stableAt(Lc), boundary: false });
    }
    if (s !== 0) lastSign = s;
  }

  // upper boundary (capacity): if the stock still grows at the ceiling it is
  // pinned there — a stable attractor the range itself imposes
  if (sign(netAt(hi)) > 0) fps.push({ level: hi, stable: true, boundary: true });
  return fps;
}

// the unstable interior fixed point — the tipping level a threshold marks.
// null when the stock is monotone (no switch).
function knifeEdge(model, nodeName, pathway = null) {
  const e = equilibria(model, nodeName, pathway).find(f => !f.stable && !f.boundary);
  return e ? e.level : null;
}

/* ---------------------------------------------------------------------
 * FATE SCAN — the French-flag reading. Sweep one *input* node across its
 * range; at each level, pin it there and let the *readout* stocks settle,
 * then report whether each has latched above its switch line. One graded
 * input read against several thresholds yields a map of combinatorial fates:
 * that map is the flag. The model stays single-compartment — "position
 * along the gradient" collapses to the swept input value, exactly as café's
 * `init` is the experiment knob. Pure analysis over the same Engine.
 *   columns[i] = { x, levels:{readout:L}, on:{readout:bool} }
 *   boundaries[readout] = input level where it first latches ON (null if never)
 * ------------------------------------------------------------------- */
function fateScan(model, inputName, readoutNames, opts = {}) {
  if (!model.nodes.has(inputName)) return null;
  const samples = opts.samples || 160;
  const settle  = opts.settle  || 40;   // model-time to reach steady state
  const inNode = model.nodes.get(inputName);
  const lo = inNode.range ? inNode.range[0] : 0;
  const hi = inNode.range ? inNode.range[1] : Math.max(10, inNode.init || 10);
  const readouts = readoutNames.filter(n => model.nodes.has(n));
  if (hi <= lo || !readouts.length) return null;

  // each readout's switch line: a numeric threshold, else its computed
  // knife-edge, else the range midpoint (a settled stock is decisive either way).
  const lineOf = name => {
    const nd = model.nodes.get(name);
    if (typeof nd.threshold === "number") return nd.threshold;
    if (nd.threshold === "auto") { const k = knifeEdge(model, name); if (k != null) return k; }
    return nd.range ? (nd.range[0] + nd.range[1]) / 2 : 1;
  };
  const lines = new Map(readouts.map(n => [n, lineOf(n)]));

  // which branch to trace: 'lo' starts each readout naive (its init/off — the
  // turn-ON edge), 'hi' starts it pre-activated (range max — the turn-OFF edge).
  // For a monostable readout the two agree; for a *bistable* one they bracket the
  // hysteresis loop. Default 'lo' = a naive field.
  const from = opts.from === "hi" ? "hi" : "lo";
  const seed = name => {
    if (from === "lo") return;                       // reset already left it at init
    const nd = model.nodes.get(name);
    eng.state.set(name, nd.range ? nd.range[1] : Math.max(10, eng.state.get(name)));
  };

  const eng = new Engine(model);
  if (opts.pathway) eng.setPathway(opts.pathway);
  const columns = [];
  for (let i = 0; i < samples; i++) {
    const x = lo + (hi - lo) * i / (samples - 1);
    eng.reset();
    eng.state.set(inputName, x);   // pin the gradient level; no flow touches it, so it holds
    for (const n of readouts) seed(n);
    eng.advance(settle);
    const on = {}, levels = {};
    for (const n of readouts) { const v = eng.state.get(n); levels[n] = v; on[n] = v >= lines.get(n); }
    columns.push({ x, levels, on });
  }

  // turn-on boundary per readout: the input level where it first latches ON
  const boundaries = {};
  for (const n of readouts) {
    let b = null;
    for (let i = 1; i < columns.length; i++)
      if (!columns[i - 1].on[n] && columns[i].on[n]) { b = (columns[i - 1].x + columns[i].x) / 2; break; }
    boundaries[n] = b;
  }
  return { input: inputName, lo, hi, samples, settle, readouts, lines: Object.fromEntries(lines), columns, boundaries };
}

return {
  VERSION: "0.1",
  RATE_LAWS, REACTION_LAWS, NODE_VISUALS, EDGE_VISUALS, FILL_KINDS, COMPARATORS, ASSIGN_OPS,
  isNumber, parseValue, splitTop, splitChannels, parseCall,
  parseModel, Engine, layout, fitView, influences, equilibria, knifeEdge, fateScan,
};
});
