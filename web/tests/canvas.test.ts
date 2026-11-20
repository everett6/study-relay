import { describe, expect, it } from "vitest";
import { cleanCourse, mergeTasks, mockESUHSD, parseAssignments, parseICS, syncCanvas, type Fetcher } from "../src/core/canvas";

const NOW = new Date(2026, 10, 19, 15, 0);

describe("canvas", () => {
  it("cleans ESUHSD course names", () => {
    expect(cleanCourse("P-BIOLOGY - Q2000XX - NGUYEN - Period 04")).toBe("Biology");
    expect(cleanCourse("P-AP CALCULUS BC - M4700XP - KUANG - Period 03")).toBe("AP Calculus BC");
    expect(cleanCourse("AP Physics C: Mechanics")).toBe("AP Physics C: Mechanics");
  });
  it("parses assignments, skipping submitted and long-past ones", () => {
    const t = parseAssignments({ id: 1, name: "P-CHEMISTRY H - S7 - X - Period 06" }, [
      { id: 1, name: "Stoichiometry Quiz", due_at: "2026-11-21T17:00:00Z", is_quiz_assignment: true },
      { id: 2, name: "Lab 3", description: "<p>Full <b>lab report</b></p>", due_at: "2026-11-23T07:59:00Z", points_possible: 30 },
      { id: 3, name: "Done HW", due_at: "2026-11-22T07:59:00Z", submission: { workflow_state: "submitted", submitted_at: "x" } },
      { id: 4, name: "Ancient HW", due_at: "2026-10-01T07:59:00Z" },
    ], NOW);
    expect(t.map((x) => [x.id, x.category])).toEqual([["canvas-1", "quiz"], ["canvas-2", "lab"]]);
    expect(t[1].description).toBe("Full lab report");
    expect(t[0].course).toBe("Chemistry H");
  });
  it("parses the ICS feed", () => {
    const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:event-assignment-77\r\nDTSTART;VALUE=DATE:20261124\r\nSUMMARY:Essay Draft [P-AMERICAN LIT\r\n  H - E13 - PATEL - Period 05]\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const t = parseICS(ics, NOW);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ title: "Essay Draft", course: "American Lit H", category: "project", due_at: "2026-11-24T23:59" });
  });
  it("follows pagination through the proxy", async () => {
    const calls: Record<string, string>[] = [];
    const f: Fetcher = async (body) => {
      calls.push(body);
      if (body.path?.startsWith("/api/v1/courses?")) return { status: 200, json: [{ id: 5, name: "P-BIOLOGY - Q - N - Period 04" }], text: "", next: null };
      if (body.path) return { status: 200, json: [{ id: 50, name: "Mitosis storyboard", due_at: "2026-11-25T07:59:00Z" }], text: "", next: "https://esuhsd.instructure.com/api/v1/courses/5/assignments?page=2" };
      return { status: 200, json: [{ id: 51, name: "Cell quiz", due_at: "2026-11-26T07:59:00Z" }], text: "", next: null };
    };
    const r = await syncCanvas(f, NOW);
    expect(r.courses).toEqual(["Biology"]);
    expect(r.tasks.map((t) => t.title)).toEqual(["Mitosis storyboard", "Cell quiz"]);
    expect(calls[2].url).toContain("page=2");
  });
  it("rejects bad tokens clearly", async () => {
    await expect(syncCanvas(async () => ({ status: 401, json: null, text: "", next: null }), NOW)).rejects.toThrow(/401/);
  });
  it("merge keeps human estimates and progress", () => {
    const first = mockESUHSD(NOW);
    expect(first.length).toBe(7);
    first[0].human_minutes = 70; first[0].est_source = "human"; first[0].logged_minutes = 20;
    const again = mockESUHSD(NOW);
    again[0].title = "Problem Set 7 (updated)";
    const r = mergeTasks(first, again);
    expect(r.added).toBe(0);
    expect(r.tasks[0]).toMatchObject({ human_minutes: 70, logged_minutes: 20, title: "Problem Set 7 (updated)" });
  });
});
