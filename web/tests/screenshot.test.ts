import { describe, expect, it } from "vitest";
import { extractItems, findDate } from "../src/app/screenshot";

const NOW = new Date(2026, 10, 19, 15, 0);

describe("screenshot text extraction", () => {
  it("finds dates in common formats", () => {
    expect(findDate("Due Nov 21 at 11:59pm", NOW)).toBe("2026-11-21T23:59");
    expect(findDate("due tomorrow 8:30 am", NOW)).toBe("2026-11-20T08:30");
    expect(findDate("Fri 5pm", NOW)).toBe("2026-11-20T17:00");
    expect(findDate("12/3", NOW)).toBe("2026-12-03T23:59");
    expect(findDate("no date here", NOW)).toBeNull();
  });
  it("pulls tasks and events from a Canvas to-do / club flyer screenshot", () => {
    const text = "To Do\nAP Physics C\nProblem Set 8\nDue Nov 24 at 11:59pm\n20 points\nRobotics meeting Friday 3:45pm in room 210";
    const items = extractItems(text, NOW);
    expect(items[0]).toMatchObject({ title: "Problem Set 8", course: "AP Physics C", due: "2026-11-24T23:59", kind: "task" });
    expect(items[1]).toMatchObject({ kind: "event", due: "2026-11-20T15:45" });
    expect(items[1].title).toBe("Robotics meeting");
  });
});
