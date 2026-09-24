/**
 * Session transitions the way Pi performs them: the extension instance of the
 * session being left receives session_shutdown, and the next session is started by
 * a *new* instance (Pi runs the factory again). Each test boots one mockPi per
 * instance to reproduce that; the single-instance tests elsewhere cannot.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { sessionTaskFile } from "../src/task-paths.js";
import { TaskStore } from "../src/task-store.js";
import { flush, installSubagentsMock, mockPi, mockSessionCtx } from "./helpers/mock-pi.js";

// Config is mocked so the developer's own tasks-config.json cannot change the scope.
const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../src/tasks-config.js", () => ({
  loadGlobalTasksConfig: () => ({ ...config.current }),
  loadTasksConfig: () => ({ ...config.current }),
  saveTasksConfig: () => {},
}));

const HANDOFF_REGISTRY = Symbol.for("@tintinweb/pi-tasks:session-handoff");

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-tasks-lifecycle-"));
  config.current = {};
  delete process.env.PI_TASKS;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.PI_TASKS;
  (globalThis as any)[HANDOFF_REGISTRY]?.clear();
  rmSync(cwd, { recursive: true, force: true });
});

/** A fresh extension instance, as Pi creates for every session. */
function boot() {
  const mock = mockPi();
  initExtension(mock.pi as any);
  return mock;
}

const ctxFor = (sessionId: string, opts: { persisted?: boolean } = {}) => mockSessionCtx(sessionId, { cwd, ...opts });

const listText = async (mock: ReturnType<typeof boot>, ctx: unknown) =>
  (await mock.executeTool("TaskList", {}, ctx)).content[0].text as string;

/**
 * Parent session with the given tasks, then /fork: shutdown on the parent's
 * instance, session_start on a new one. Returns the child's instance and context.
 */
async function forkWith(subjects: string[], opts: { persisted?: boolean } = {}) {
  const parent = boot();
  const ctxP = ctxFor("parent", opts);
  await parent.fireLifecycle("session_start", { reason: "startup" }, ctxP);
  for (const subject of subjects) await parent.executeTool("TaskCreate", { subject, description: "d" }, ctxP);
  const ctxC = ctxFor("child", opts);
  await parent.fireLifecycle(
    "session_shutdown",
    { reason: "fork", targetSessionFile: ctxC.sessionManager.getSessionFile() },
    ctxP,
  );
  const child = boot();
  await child.fireLifecycle("session_start", { reason: "fork" }, ctxC);
  return { parent, ctxP, child, ctxC };
}

/**
 * A session with the given tasks, then /reload: shutdown on its instance, and
 * session_start on a new instance of the same session. Returns the new instance.
 * `between` runs after the shutdown, where another process could touch the files.
 */
async function reloadWith(subjects: string[], opts: { persisted?: boolean; between?: () => void } = {}) {
  const before = boot();
  const ctx = ctxFor("reloaded", opts);
  await before.fireLifecycle("session_start", { reason: "startup" }, ctx);
  for (const subject of subjects) await before.executeTool("TaskCreate", { subject, description: "d" }, ctx);
  await before.fireLifecycle("session_shutdown", { reason: "reload" }, ctx);
  opts.between?.();
  const after = boot();
  await after.fireLifecycle("session_start", { reason: "reload" }, ctx);
  return { before, after, ctx };
}

describe("fork across extension instances", () => {
  it("seeds the forked session's file with the parent's tasks (session scope)", async () => {
    await forkWith(["Inherited"]);
    expect(new TaskStore(sessionTaskFile(cwd, "child", "session")).list().map(t => t.subject)).toEqual(["Inherited"]);
  });

  it("seeds the forked session's file under session-global scope", async () => {
    config.current = { taskScope: "session-global" };
    await forkWith(["Inherited"]);
    const file = sessionTaskFile(cwd, "child", "session-global");
    expect(new TaskStore(file).list().map(t => t.subject)).toEqual(["Inherited"]);
  });

  it("carries in-memory tasks into the fork (memory scope)", async () => {
    config.current = { taskScope: "memory" };
    const { child, ctxC } = await forkWith(["Inherited"]);
    expect(await listText(child, ctxC)).toContain("Inherited");
  });

  it("carries tasks of a session Pi does not persist (--no-session)", async () => {
    const { child, ctxC } = await forkWith(["Inherited"], { persisted: false });
    expect(await listText(child, ctxC)).toContain("Inherited");
  });

  it("does not duplicate a shared project list", async () => {
    config.current = { taskScope: "project" };
    const { child, ctxC } = await forkWith(["Shared"]);
    expect(new TaskStore(join(cwd, ".pi", "tasks", "tasks.json")).list().map(t => t.subject)).toEqual(["Shared"]);
    expect((await listText(child, ctxC)).match(/Shared/g)).toHaveLength(1);
  });

  it("does not duplicate a list shared through a PI_TASKS path", async () => {
    const file = join(cwd, "shared.json");
    process.env.PI_TASKS = file;
    await forkWith(["Shared"]);
    expect(new TaskStore(file).list().map(t => t.subject)).toEqual(["Shared"]);
  });

  it("keeps the fork independent of the parent", async () => {
    const { child, ctxC } = await forkWith(["Inherited"]);
    await child.executeTool("TaskCreate", { subject: "Fork only", description: "d" }, ctxC);
    expect(new TaskStore(sessionTaskFile(cwd, "parent", "session")).list().map(t => t.subject)).toEqual(["Inherited"]);
  });

  it("leaves a fork target that already has tasks as it is", async () => {
    new TaskStore(sessionTaskFile(cwd, "child", "session")).create("Own task", "d");
    await forkWith(["Inherited"]);
    expect(new TaskStore(sessionTaskFile(cwd, "child", "session")).list().map(t => t.subject)).toEqual(["Own task"]);
  });

  it("does not carry tasks into /new or /resume", async () => {
    for (const reason of ["new", "resume"]) {
      const parent = boot();
      const ctxP = ctxFor(`parent-${reason}`);
      await parent.fireLifecycle("session_start", { reason: "startup" }, ctxP);
      await parent.executeTool("TaskCreate", { subject: "Stays behind", description: "d" }, ctxP);
      const ctxN = ctxFor(`next-${reason}`);
      await parent.fireLifecycle("session_shutdown", { reason, targetSessionFile: ctxN.sessionManager.getSessionFile() }, ctxP);
      const next = boot();
      await next.fireLifecycle("session_start", { reason }, ctxN);
      expect(await listText(next, ctxN)).toBe("No tasks found");
    }
  });

  it("relinks a subagent still running for a carried task", async () => {
    const parent = boot();
    const ctxP = ctxFor("parent");
    await parent.fireLifecycle("session_start", { reason: "startup" }, ctxP);
    installSubagentsMock(parent.pi);
    await flush();
    await parent.executeTool("TaskCreate", { subject: "Delegated", description: "d", agentType: "general-purpose" }, ctxP);
    await parent.executeTool("TaskExecute", { task_ids: ["1"] }, ctxP);
    const ctxC = ctxFor("child");
    await parent.fireLifecycle("session_shutdown", { reason: "fork", targetSessionFile: ctxC.sessionManager.getSessionFile() }, ctxP);

    const child = boot();
    const subagents = installSubagentsMock(child.pi);
    await child.fireLifecycle("session_start", { reason: "fork" }, ctxC);
    subagents.complete("agent-1", "delegated result");
    await flush();

    const task = new TaskStore(sessionTaskFile(cwd, "child", "session")).get("1");
    expect(task?.status).toBe("completed");
    expect(task?.metadata.result).toBe("delegated result");
  });

  it("still seeds a fork when the host reuses one instance", async () => {
    const mock = boot();
    const ctxP = ctxFor("parent");
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxP);
    await mock.executeTool("TaskCreate", { subject: "Inherited", description: "d" }, ctxP);
    const ctxC = ctxFor("child");
    await mock.fireLifecycle("session_shutdown", { reason: "fork", targetSessionFile: ctxC.sessionManager.getSessionFile() }, ctxP);
    await mock.fireLifecycle("session_start", { reason: "fork" }, ctxC);
    expect(new TaskStore(sessionTaskFile(cwd, "child", "session")).list().map(t => t.subject)).toEqual(["Inherited"]);
    expect(ctxC.ui.setWidget).toHaveBeenCalledWith("tasks", expect.any(Function), { placement: "aboveEditor" });
  });
});

describe("reload across extension instances", () => {
  it("keeps memory-scope tasks and shows them", async () => {
    config.current = { taskScope: "memory" };
    const { after, ctx } = await reloadWith(["Alpha", "Beta"]);
    const list = await listText(after, ctx);
    expect(list).toContain("Alpha");
    expect(list).toContain("Beta");
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("tasks", expect.any(Function), { placement: "aboveEditor" });
  });

  it("keeps the tasks of a session Pi does not persist (--no-session)", async () => {
    const { after, ctx } = await reloadWith(["Alpha"], { persisted: false });
    expect(await listText(after, ctx)).toContain("Alpha");
  });

  it("keeps the tasks of an in-memory list forced by PI_TASKS=off", async () => {
    process.env.PI_TASKS = "off";
    const { after, ctx } = await reloadWith(["Alpha"]);
    expect(await listText(after, ctx)).toContain("Alpha");
  });

  it("continues task IDs after the carried tasks", async () => {
    config.current = { taskScope: "memory" };
    const { after, ctx } = await reloadWith(["Alpha", "Beta"]);
    const result = await after.executeTool("TaskCreate", { subject: "Gamma", description: "d" }, ctx);
    expect(result.content[0].text).toBe("Task #3 created successfully: Gamma");
  });

  it.each(["session", "project"])("re-reads a %s-scope file instead of restoring a copy", async taskScope => {
    config.current = { taskScope };
    const file = taskScope === "project" ? join(cwd, ".pi", "tasks", "tasks.json") : sessionTaskFile(cwd, "reloaded", "session");
    // Another session empties the file while this one reloads; the file is the truth.
    const { after, ctx } = await reloadWith(["Alpha"], { between: () => new TaskStore(file).clearAll() });
    expect(await listText(after, ctx)).toBe("No tasks found");
  });

  it("never writes an in-memory list into a file when the scope changed", async () => {
    config.current = { taskScope: "memory" };
    const { after, ctx } = await reloadWith(["Alpha"], { between: () => { config.current = { taskScope: "session" }; } });
    expect(await listText(after, ctx)).toBe("No tasks found");
    expect(existsSync(sessionTaskFile(cwd, "reloaded", "session"))).toBe(false);
  });

  it("relinks a subagent still running for an in-memory task", async () => {
    config.current = { taskScope: "memory" };
    const before = boot();
    const ctx = ctxFor("reloaded");
    await before.fireLifecycle("session_start", { reason: "startup" }, ctx);
    installSubagentsMock(before.pi);
    await flush();
    await before.executeTool("TaskCreate", { subject: "Delegated", description: "d", agentType: "general-purpose" }, ctx);
    await before.executeTool("TaskExecute", { task_ids: ["1"] }, ctx);
    await before.fireLifecycle("session_shutdown", { reason: "reload" }, ctx);

    const after = boot();
    const subagents = installSubagentsMock(after.pi);
    await after.fireLifecycle("session_start", { reason: "reload" }, ctx);
    subagents.complete("agent-1", "delegated result");
    await flush();

    expect(await listText(after, ctx)).toContain("[completed] Delegated");
  });
});

// pi-subagents aborts every agent when a session ends, and reports each one as
// `aborted` from its own session_shutdown handler. That handler runs before or after
// pi-tasks' one, depending on which extension loads first.
describe("a subagent cut short by the end of the session", () => {
  const SESSION_ENDED = "The session ended before the agent finished.";

  async function endWhileRunning(reason: "fork" | "reload", reportFirst: boolean) {
    const before = boot();
    const ctx = ctxFor("delegating");
    await before.fireLifecycle("session_start", { reason: "startup" }, ctx);
    const subagents = installSubagentsMock(before.pi);
    await flush();
    await before.executeTool("TaskCreate", { subject: "Delegated", description: "d", agentType: "general-purpose" }, ctx);
    await before.executeTool("TaskExecute", { task_ids: ["1"] }, ctx);

    const next = reason === "fork" ? ctxFor("forked") : ctx;
    const report = () => subagents.fail("agent-1", SESSION_ENDED, "aborted");
    if (reportFirst) report();
    const targetSessionFile = reason === "fork" ? next.sessionManager.getSessionFile() : undefined;
    await before.fireLifecycle("session_shutdown", { reason, targetSessionFile }, ctx);
    if (!reportFirst) report();

    const after = boot();
    await after.fireLifecycle("session_start", { reason }, next);
    return { after, next };
  }

  const taskText = async (mock: ReturnType<typeof boot>, ctx: unknown) =>
    (await mock.executeTool("TaskGet", { taskId: "1" }, ctx)).content[0].text as string;

  it.each([true, false])("reverts the fork's copy and the parent's task to pending (report first: %s)", async reportFirst => {
    const { after, next } = await endWhileRunning("fork", reportFirst);
    const text = await taskText(after, next);
    expect(text).toContain("Status: pending");
    expect(text).toContain(SESSION_ENDED);
    expect(new TaskStore(sessionTaskFile(cwd, "delegating", "session")).get("1")?.status).toBe("pending");
  });

  it.each([true, false])("reverts an in-memory task carried across /reload (report first: %s)", async reportFirst => {
    config.current = { taskScope: "memory" };
    const { after, next } = await endWhileRunning("reload", reportFirst);
    const text = await taskText(after, next);
    expect(text).toContain("Status: pending");
    expect(text).toContain(SESSION_ENDED);
  });
});

describe("session_shutdown", () => {
  /** A session with task #1 in progress, so the widget spinner is running. */
  async function spinning() {
    const mock = boot();
    vi.useFakeTimers();
    const ctx = ctxFor("spinning");
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.executeTool("TaskCreate", { subject: "Busy", description: "d" }, ctx);
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" }, ctx);
    return { mock, ctx };
  }

  it("stops the spinner timer and clears the widget", async () => {
    const { mock, ctx } = await spinning();
    expect(vi.getTimerCount()).toBe(1);
    await mock.fireLifecycle("session_shutdown", { reason: "quit" }, ctx);
    expect(vi.getTimerCount()).toBe(0);
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("tasks", undefined);
  });

  it("leaves the replaced instance unable to draw", async () => {
    const { mock, ctx } = await spinning();
    await mock.fireLifecycle("session_shutdown", { reason: "new" }, ctx);
    const calls = ctx.ui.setWidget.mock.calls.length;
    // Work still in flight in the old instance lands after shutdown: it starts a
    // spinner, then empties the list. Both used to reach the UI.
    await mock.executeTool("TaskCreate", { subject: "Late", description: "d" }, ctx);
    await mock.executeTool("TaskUpdate", { taskId: "2", status: "in_progress" }, ctx);
    vi.advanceTimersByTime(1_000);
    expect(vi.getTimerCount()).toBe(0);
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "deleted" }, ctx);
    await mock.executeTool("TaskUpdate", { taskId: "2", status: "deleted" }, ctx);
    expect(ctx.ui.setWidget.mock.calls.length).toBe(calls);
  });
});

describe("widget failures", () => {
  it("do not fail the tool call that changed the store", async () => {
    const mock = boot();
    const ctx = ctxFor("broken-ui");
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    ctx.ui.setWidget.mockImplementation(() => { throw new Error("UI gone"); });
    const result = await mock.executeTool("TaskCreate", { subject: "Kept", description: "d" }, ctx);
    expect(result.content[0].text).toBe("Task #1 created successfully: Kept");
    expect(await listText(mock, ctx)).toContain("Kept");
  });
});
