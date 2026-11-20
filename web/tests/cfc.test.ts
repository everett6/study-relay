import { describe, expect, it } from "vitest";
import { CfCScheduler, features, RATIO_MAX, RATIO_MIN } from "../src/ai/cfcScheduler";
import type { CfCStep } from "../src/core/types";

const t0 = new Date(2026, 10, 16, 16, 0).getTime();
function seq(n: number, ratio = 1.4): CfCStep[] {
  return Array.from({ length: n }, (_, i) => {
    const at = new Date(t0 + i * 26 * 3600000 + (i % 3) * 3600000); // irregular gaps
    return { t: at.getTime(), x: features(at, i % 2 ? "HW" : "Exam", 30 + 10 * i, 1, "med", i % 4 === 0), y: Math.log(ratio + 0.05 * (i % 2)) };
  });
}

describe("CfC scheduler", () => {
  it("analytic gradients match finite differences", () => {
    const net = new CfCScheduler({ hidden: 4, backbone: 5, seed: 3 });
    const s = seq(5);
    const { grad } = net.lossAndGrad(s);
    const eps = 1e-5;
    const idx = [0, 7, net.L.W1 + 2, net.L.Wa + 1, net.L.logTau, net.L.logTau + 3, net.L.Wo + 1, net.L.bo];
    for (const i of idx) {
      const p0 = net.params[i];
      net.params[i] = p0 + eps; const lp = net.lossAndGrad(s).loss;
      net.params[i] = p0 - eps; const lm = net.lossAndGrad(s).loss;
      net.params[i] = p0;
      const num = (lp - lm) / (2 * eps);
      expect(Math.abs(num - grad[i])).toBeLessThan(1e-6 + 1e-4 * Math.abs(num));
    }
  });

  it("time constants receive gradient (dt actually matters)", () => {
    const net = new CfCScheduler({ seed: 5 });
    const g = net.lossAndGrad(seq(6)).grad;
    const tauGrad = Array.from({ length: net.H }, (_, j) => Math.abs(g[net.L.logTau + j]));
    expect(Math.max(...tauGrad)).toBeGreaterThan(0);
  });

  it("online updates reduce loss and move predictions toward the observed pace", () => {
    const net = new CfCScheduler({ seed: 11, lr: 0.02 });
    const s = seq(10, 1.5);
    const before = net.lossAndGrad(s).loss;
    for (let k = 0; k < 40; k++) net.trainStep(s, 1);
    const after = net.lossAndGrad(s).loss;
    expect(after).toBeLessThan(before * 0.5);
    net.history = s;
    const q = new Date(t0 + 12 * 26 * 3600000);
    const r = net.predict(q, features(q, "HW", 60, 1.5, "med", false));
    expect(r).toBeGreaterThan(1.2);
    expect(r).toBeLessThanOrEqual(RATIO_MAX);
  });

  it("an untrained net predicts ~1.0 and trust ramps with history", () => {
    const net = new CfCScheduler();
    const at = new Date(t0);
    expect(net.predict(at, features(at, "HW", 40, 1, null, false))).toBeCloseTo(1, 1);
    const r = net.predict(at, features(at, "HW", 40, 1, null, false));
    expect(r).toBeGreaterThanOrEqual(RATIO_MIN);
  });

  it("observe() trains immediately and the snapshot round-trips", () => {
    const net = new CfCScheduler({ seed: 2 });
    const p0 = [...net.params];
    const at = new Date(t0);
    net.observe(at, features(at, "Lab", 75, 1, "low", false), 1.6, "Physics");
    expect(net.updates).toBe(1);
    expect(net.params.some((p, i) => p !== p0[i])).toBe(true);
    const copy = CfCScheduler.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    expect(copy.params).toEqual(net.params);
    expect(copy.history.length).toBe(1);
    expect(copy.paceFor("Physics")).toBeGreaterThan(1);
    expect(copy.tau().every((t) => t > 0)).toBe(true);
  });
});
