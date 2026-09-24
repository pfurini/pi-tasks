import { afterEach, describe, expect, it } from "vitest";
import { handoffKey, leaveHandoff, takeHandoff } from "../src/session-handoff.js";
import type { TaskStoreData } from "../src/types.js";

const REGISTRY_KEY = Symbol.for("@tintinweb/pi-tasks:session-handoff");

function storeData(...subjects: string[]): TaskStoreData {
  return {
    nextId: subjects.length + 1,
    tasks: subjects.map((subject, i) => ({
      id: String(i + 1),
      subject,
      description: "",
      status: "pending" as const,
      metadata: {},
      blocks: [],
      blockedBy: [],
      createdAt: 1,
      updatedAt: 1,
    })),
  };
}

/** A handoff over `data`, read as it stands when taken. */
const over = (data: TaskStoreData, sourcePath?: string) => ({ sourcePath, read: () => data });

afterEach(() => {
  (globalThis as any)[REGISTRY_KEY]?.clear();
});

describe("session handoff", () => {
  it("keys a persisted session by its file and an unpersisted one by its workspace", () => {
    expect(handoffKey("/sessions/a.jsonl", "/work")).toBe("/sessions/a.jsonl");
    expect(handoffKey(undefined, "/work")).toBe("in-memory:/work");
  });

  it("hands a handoff over exactly once, with its source", () => {
    leaveHandoff("k", over(storeData("Alpha"), "/tasks/a.json"));
    const taken = takeHandoff("k");
    expect(taken?.sourcePath).toBe("/tasks/a.json");
    expect(taken?.data.tasks.map(t => t.subject)).toEqual(["Alpha"]);
    expect(takeHandoff("k")).toBeUndefined();
  });

  it("returns nothing for a key that has no handoff", () => {
    leaveHandoff("k", over(storeData("Alpha")));
    expect(takeHandoff("other")).toBeUndefined();
  });

  it("replaces an earlier handoff for the same key", () => {
    leaveHandoff("k", over(storeData("Old")));
    leaveHandoff("k", over(storeData("New")));
    expect(takeHandoff("k")?.data.tasks.map(t => t.subject)).toEqual(["New"]);
  });

  it("reads the source when taken, so changes made after leaving it are included", () => {
    const data = storeData("Delegated");
    data.tasks[0].status = "in_progress";
    leaveHandoff("k", over(data));
    // What pi-subagents' shutdown report causes once pi-tasks has already shut down.
    data.tasks[0].status = "pending";
    data.tasks[0].metadata = { lastError: "The session ended before the agent finished." };
    expect(takeHandoff("k")?.data.tasks[0]).toMatchObject({
      status: "pending",
      metadata: { lastError: "The session ended before the agent finished." },
    });
  });

  it("returns a copy, so the next session cannot change the old one's tasks", () => {
    const data = storeData("Alpha");
    leaveHandoff("k", over(data));
    const taken = takeHandoff("k");
    taken!.data.tasks[0].subject = "Changed";
    expect(data.tasks[0].subject).toBe("Alpha");
  });

  it("keeps the registry on globalThis, where a re-evaluated module still finds it", () => {
    leaveHandoff("k", over(storeData("Alpha")));
    expect((globalThis as any)[REGISTRY_KEY]).toBeInstanceOf(Map);
    expect((globalThis as any)[REGISTRY_KEY].has("k")).toBe(true);
  });
});
