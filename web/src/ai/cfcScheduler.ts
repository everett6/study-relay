// Client-side Closed-form Continuous-time (CfC) liquid network.
//
// Cell (Hasani et al., 2022) with a learnable per-unit time constant tau:
//   z   = tanh(Wb [x; h] + bb)                    backbone
//   f1  = tanh(W1 z + b1),  f2 = tanh(W2 z + b2)  two target states
//   g   = sigmoid(Wa z * dt / tau + Wt z + bt)    time gate over the irregular interval dt
//   h'  = f1 * (1 - g) + g * f2
//   y   = Wo h' + bo                              predicted log pace ratio (actual / predicted)
// Training uses a small reverse-mode autodiff (exact gradients, checked against finite
// differences in tests) and Adam. Weights are plain number arrays so they serialise to
// IndexedDB and to the relay's /api/sync document.

import type { CfCSnapshot, CfCStep } from "../core/types";

export const FEATURES = ["time_of_day", "day_of_week", "task_type", "llm_initial_minutes",
  "course_pace_ratio", "energy_level", "event_flag"] as const;
export const N_IN = FEATURES.length;
const TYPE_CODE: Record<string, number> = { HW: 0, Quiz: 1, Exam: 2, Project: 3, Lab: 4, Goal: 5 };
const ENERGY: Record<string, number> = { low: 0, med: 0.5, high: 1 };
export const RATIO_MIN = 0.5, RATIO_MAX = 2.0;

export function features(at: Date, taskType: string, minutes: number, paceRatio: number,
  energy: string | null | undefined, eventFlag: boolean): number[] {
  return [
    (at.getHours() * 60 + at.getMinutes()) / 1440,
    ((at.getDay() + 6) % 7) / 6,
    (TYPE_CODE[taskType] ?? 0) / 5,
    Math.min(minutes, 300) / 300,
    Math.log(Math.min(4, Math.max(0.25, paceRatio))),
    energy ? ENERGY[energy] ?? 0.5 : 0.5,
    eventFlag ? 1 : 0,
  ];
}

// ------------------------------------------------------------------ tiny autodiff
export class V {
  grad = 0;
  constructor(public data: number, public prev: V[] = [], public back: () => void = () => {}) {}
}
const add = (a: V, b: V) => { const o = new V(a.data + b.data, [a, b]); o.back = () => { a.grad += o.grad; b.grad += o.grad; }; return o; };
const mul = (a: V, b: V) => { const o = new V(a.data * b.data, [a, b]); o.back = () => { a.grad += b.data * o.grad; b.grad += a.data * o.grad; }; return o; };
const tanhV = (a: V) => { const t = Math.tanh(a.data); const o = new V(t, [a]); o.back = () => { a.grad += (1 - t * t) * o.grad; }; return o; };
const sigV = (a: V) => { const s = 1 / (1 + Math.exp(-a.data)); const o = new V(s, [a]); o.back = () => { a.grad += s * (1 - s) * o.grad; }; return o; };
const expV = (a: V) => { const e = Math.exp(a.data); const o = new V(e, [a]); o.back = () => { a.grad += e * o.grad; }; return o; };
const sumV = (xs: V[]) => { const o = new V(xs.reduce((s, x) => s + x.data, 0), xs); o.back = () => { for (const x of xs) x.grad += o.grad; }; return o; };

function backward(root: V): void {
  const topo: V[] = [];
  const seen = new Set<V>();
  const stack: [V, boolean][] = [[root, false]];
  while (stack.length) { // iterative DFS: graphs have tens of thousands of nodes
    const [n, done] = stack.pop()!;
    if (done) { topo.push(n); continue; }
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push([n, true]);
    for (const p of n.prev) if (!seen.has(p)) stack.push([p, false]);
  }
  root.grad = 1;
  for (let i = topo.length - 1; i >= 0; i--) topo[i].back();
}

// Generic ops so one forward pass serves both fast inference (numbers) and training (V).
interface Ops<T> { c(x: number): T; add(a: T, b: T): T; mul(a: T, b: T): T; tanh(a: T): T; sig(a: T): T; exp(a: T): T; sum(xs: T[]): T }
const NUM: Ops<number> = { c: (x) => x, add: (a, b) => a + b, mul: (a, b) => a * b, tanh: Math.tanh,
  sig: (a) => 1 / (1 + Math.exp(-a)), exp: Math.exp, sum: (xs) => xs.reduce((s, x) => s + x, 0) };
const VAR: Ops<V> = { c: (x) => new V(x), add, mul, tanh: tanhV, sig: sigV, exp: expV, sum: sumV };

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Layout { Wb: number; bb: number; W1: number; b1: number; W2: number; b2: number;
  Wa: number; Wt: number; bt: number; logTau: number; Wo: number; bo: number; size: number }

export function layout(H: number, B: number): Layout {
  let o = 0;
  const take = (n: number) => { const s = o; o += n; return s; };
  const L = { Wb: take(B * (N_IN + H)), bb: take(B), W1: take(H * B), b1: take(H), W2: take(H * B), b2: take(H),
    Wa: take(H * B), Wt: take(H * B), bt: take(H), logTau: take(H), Wo: take(H), bo: take(1), size: 0 };
  L.size = o;
  return L;
}

const DAY_MS = 86400000;
export function timespans(ts: number[]): number[] {
  return ts.map((t, i) => (i === 0 ? 1 : Math.min(7, Math.max(0.01, Math.abs(t - ts[i - 1]) / DAY_MS))));
}

export class CfCScheduler {
  H: number; B: number; L: Layout;
  params: number[]; m: number[]; v: number[];
  step = 0; updates = 0; lastLoss: number | null = null;
  history: CfCStep[] = [];
  lr: number;
  private _prefix: { h: number[]; lastT: number; n: number; step: number } | null = null;
  private _paceCache = new Map<string, number>();

  constructor(opts: { hidden?: number; backbone?: number; seed?: number; lr?: number } = {}) {
    this.H = opts.hidden ?? 8;
    this.B = opts.backbone ?? 12;
    this.lr = opts.lr ?? 0.01;
    this.L = layout(this.H, this.B);
    const rnd = mulberry32(opts.seed ?? 7);
    const p = new Array(this.L.size).fill(0);
    const init = (off: number, n: number, fanIn: number, scale = 1) => {
      const lim = Math.sqrt(6 / (fanIn + 1)) * scale;
      for (let i = 0; i < n; i++) p[off + i] = (rnd() * 2 - 1) * lim;
    };
    const { H, B, L } = this;
    init(L.Wb, B * (N_IN + H), N_IN + H);
    init(L.W1, H * B, B); init(L.W2, H * B, B); init(L.Wa, H * B, B); init(L.Wt, H * B, B);
    init(L.Wo, H, H, 0.05); // near-zero output: an untrained net predicts ratio ~1.0
    this.params = p;
    this.m = new Array(p.length).fill(0);
    this.v = new Array(p.length).fill(0);
  }

  private stepCell<T>(ops: Ops<T>, P: T[], x: number[], dtVal: number, h: T[], invTau: T[]): { nh: T[]; y: T } {
    const { H, B, L } = this;
    const inp: T[] = x.map((v) => ops.c(v)).concat(h);
    const z: T[] = [];
    for (let i = 0; i < B; i++) {
      const terms: T[] = [P[L.bb + i]];
      for (let k = 0; k < inp.length; k++) terms.push(ops.mul(P[L.Wb + i * inp.length + k], inp[k]));
      z.push(ops.tanh(ops.sum(terms)));
    }
    const lin = (W: number, b: number | null, j: number): T => {
      const terms: T[] = b === null ? [] : [P[b + j]];
      for (let i = 0; i < B; i++) terms.push(ops.mul(P[W + j * B + i], z[i]));
      return ops.sum(terms);
    };
    const dt = ops.c(dtVal);
    const nh: T[] = [];
    for (let j = 0; j < H; j++) {
      const f1 = ops.tanh(lin(L.W1, L.b1, j));
      const f2 = ops.tanh(lin(L.W2, L.b2, j));
      const g = ops.sig(ops.add(ops.mul(ops.mul(lin(L.Wa, null, j), dt), invTau[j]), lin(L.Wt, L.bt, j)));
      nh.push(ops.add(ops.mul(f1, ops.add(ops.c(1), ops.mul(ops.c(-1), g))), ops.mul(g, f2)));
    }
    const y = ops.sum([P[L.bo], ...nh.map((hj, j) => ops.mul(P[L.Wo + j], hj))]);
    return { nh, y };
  }

  private forward<T>(ops: Ops<T>, P: T[], xs: number[][], dts: number[]): T[] {
    let h: T[] = Array.from({ length: this.H }, () => ops.c(0));
    const ys: T[] = [];
    const invTau = Array.from({ length: this.H }, (_, j) => ops.exp(ops.mul(ops.c(-1), P[this.L.logTau + j])));
    for (let t = 0; t < xs.length; t++) {
      const res = this.stepCell(ops, P, xs[t], dts[t], h, invTau);
      h = res.nh;
      ys.push(res.y);
    }
    return ys;
  }

  /** Predicted log ratio at each step (fast numeric path). */
  run(seq: CfCStep[]): number[] {
    return this.forward(NUM, this.params, seq.map((s) => s.x), timespans(seq.map((s) => s.t)));
  }

  /** Loss and exact gradients for a sequence with targets. */
  lossAndGrad(seq: CfCStep[]): { loss: number; grad: number[] } {
    const P = this.params.map((x) => new V(x));
    const ys = this.forward(VAR, P, seq.map((s) => s.x), timespans(seq.map((s) => s.t)));
    const terms: V[] = [];
    seq.forEach((s, i) => {
      if (s.y === undefined) return;
      const d = add(ys[i], new V(-s.y));
      terms.push(mul(d, d));
    });
    if (!terms.length) return { loss: 0, grad: new Array(P.length).fill(0) };
    const loss = mul(sumV(terms), new V(1 / terms.length));
    backward(loss);
    return { loss: loss.data, grad: P.map((p) => p.grad) };
  }

  /** One online update (a few Adam steps on the most recent window). Returns the last loss. */
  trainStep(seq: CfCStep[], steps = 3, window = 16): number {
    const s = seq.slice(-window);
    let loss = NaN;
    for (let k = 0; k < steps; k++) {
      const r = this.lossAndGrad(s);
      loss = r.loss;
      const norm = Math.sqrt(r.grad.reduce((a, g) => a + g * g, 0));
      const clip = norm > 1 ? 1 / norm : 1;
      this.step++;
      const b1 = 0.9, b2 = 0.999, eps = 1e-8;
      for (let i = 0; i < this.params.length; i++) {
        const g = r.grad[i] * clip;
        this.m[i] = b1 * this.m[i] + (1 - b1) * g;
        this.v[i] = b2 * this.v[i] + (1 - b2) * g * g;
        const mh = this.m[i] / (1 - b1 ** this.step), vh = this.v[i] / (1 - b2 ** this.step);
        this.params[i] -= (this.lr * mh) / (Math.sqrt(vh) + eps);
      }
      for (let j = 0; j < this.H; j++) { // keep tau in a sane range (minutes .. weeks)
        const i = this.L.logTau + j;
        this.params[i] = Math.min(3, Math.max(-5, this.params[i]));
      }
    }
    this.updates++;
    this.lastLoss = loss;
    return loss;
  }

  /** Record an observed (features, ratio) event and train on it immediately. */
  observe(at: Date, x: number[], ratio: number, key?: string): number {
    this.history.push({ t: at.getTime(), x, y: Math.log(Math.min(4, Math.max(0.25, ratio))), key });
    if (this.history.length > 64) this.history = this.history.slice(-64);
    this._prefix = null;
    this._paceCache.clear();
    return this.trainStep(this.history);
  }

  /** Pace ratio for a query given history; caches prefix hidden state for O(1) predictions. */
  predict(at: Date, x: number[]): number {
    const tail = this.history.slice(-15);
    const invTau = Array.from({ length: this.H }, (_, j) => Math.exp(-this.params[this.L.logTau + j]));
    if (!this._prefix || this._prefix.n !== tail.length || this._prefix.step !== this.step) {
      let h = Array.from({ length: this.H }, () => 0);
      const dts = timespans(tail.map((s) => s.t));
      for (let i = 0; i < tail.length; i++) {
        h = this.stepCell(NUM, this.params, tail[i].x, dts[i], h, invTau).nh;
      }
      this._prefix = { h, lastT: tail.length ? tail[tail.length - 1].t : 0, n: tail.length, step: this.step };
    }
    const dt = tail.length ? Math.min(7, Math.max(0.01, Math.abs(at.getTime() - this._prefix.lastT) / DAY_MS)) : 1;
    const raw = Math.exp(this.stepCell(NUM, this.params, x, dt, this._prefix.h, invTau).y);
    const trust = Math.min(1, this.history.length / 10);
    return Math.min(RATIO_MAX, Math.max(RATIO_MIN, 1 + (raw - 1) * trust));
  }

  /** EWMA of observed ratios for a course/bucket key (feeds the course_pace_ratio feature). */
  paceFor(key?: string): number {
    const ck = key ?? "";
    const hit = this._paceCache.get(ck);
    if (hit !== undefined) return hit;
    let e = 1;
    for (const s of this.history) if (s.y !== undefined && (!key || s.key === key)) e = 0.7 * e + 0.3 * Math.exp(s.y);
    this._paceCache.set(ck, e);
    return e;
  }

  tau(): number[] {
    return Array.from({ length: this.H }, (_, j) => Math.exp(this.params[this.L.logTau + j]));
  }

  toJSON(): CfCSnapshot {
    return { hidden: this.H, backbone: this.B, params: [...this.params], m: [...this.m], v: [...this.v],
      step: this.step, updates: this.updates, last_loss: this.lastLoss, history: this.history };
  }

  static fromJSON(s: CfCSnapshot | null | undefined): CfCScheduler {
    const net = new CfCScheduler({ hidden: s?.hidden, backbone: s?.backbone });
    if (s && s.params?.length === net.params.length) {
      net.params = [...s.params];
      net.m = s.m?.length === net.params.length ? [...s.m] : net.m;
      net.v = s.v?.length === net.params.length ? [...s.v] : net.v;
      net.step = s.step ?? 0;
      net.updates = s.updates ?? 0;
      net.lastLoss = s.last_loss ?? null;
      net.history = s.history ?? [];
    }
    return net;
  }
}
