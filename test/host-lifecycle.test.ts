/**
 * pi-tasks inside a real Pi session runtime, across the session transitions Pi
 * performs: /new, /resume, /fork and /reload each hand the next session to a fresh
 * extension instance. See test/helpers/pi-host.ts for how the host is built.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type PiHost, startPiHost, textReply, toolCalls } from "./helpers/pi-host.js";

const TASK_TOOLS = ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskOutput", "TaskStop", "TaskExecute"];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let host: PiHost | undefined;
afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

/** Two tasks, the first in progress with its spinner running. */
async function createTwoTasks(h: PiHost) {
  h.respond(
    toolCalls(["TaskCreate", { subject: "Alpha", description: "first" }], ["TaskCreate", { subject: "Beta", description: "second" }]),
    toolCalls(["TaskUpdate", { taskId: "1", status: "in_progress" }]),
    textReply("working"),
  );
  await h.prompt("plan");
}

/** What TaskList returns to the model in the current session. */
async function listedByModel(h: PiHost): Promise<string> {
  h.respond(toolCalls(["TaskList", {}]), textReply("listed"));
  await h.prompt("list");
  return h.requests[h.requests.length - 1].lastToolResult ?? "";
}

describe("pi-tasks in a real Pi runtime", { timeout: 30_000 }, () => {
  it("loads cleanly and declares every task tool to the model", async () => {
    host = await startPiHost();
    expect(host.runtime.session.getActiveToolNames()).toEqual(expect.arrayContaining(TASK_TOOLS));
    host.respond(textReply("hello"));
    await host.prompt("hi");
    expect(host.requests[0].tools).toEqual(expect.arrayContaining(TASK_TOOLS));
    expect(host.lifecycle).toContain("start:startup");
    expect(host.errors).toEqual([]);
  });

  it("persists tasks the model creates and shows them in the widget", async () => {
    host = await startPiHost();
    await createTwoTasks(host);
    expect(host.requests[1].lastToolResult).toContain("created successfully");
    expect(host.storedSubjects()).toEqual(["Alpha", "Beta"]);
    expect(host.widgetLines()[0]).toContain("2 tasks");
  });

  it("reminds the model of stale in-progress work without persisting the reminder", async () => {
    host = await startPiHost();
    await createTwoTasks(host);
    for (const text of ["one", "two", "three"]) {
      host.respond(textReply(`ok ${text}`));
      await host.prompt(text);
    }
    expect(host.requests.some(request => request.lastText.includes("<system-reminder>"))).toBe(true);
    const sessionFile = host.runtime.session.sessionFile;
    expect(sessionFile).toBeDefined();
    expect(readFileSync(sessionFile as string, "utf8")).not.toContain("system-reminder");
  });

  it("opens the /tasks menu and its settings panel", async () => {
    host = await startPiHost();
    host.selectAnswers.push("Settings", undefined);
    await host.prompt("/tasks");
    expect(host.selects[0].title).toBe("Tasks");
    expect(host.customRenders[0].some(line => line.includes("Task Settings"))).toBe(true);
    expect(host.errors).toEqual([]);
  });

  it.each(["session", "session-global", "memory", "project"] as const)(
    "carries the parent's tasks into a fork (%s scope)",
    async taskScope => {
      host = await startPiHost({ taskScope });
      await createTwoTasks(host);
      await host.fork();
      expect(host.lifecycle).toContain("start:fork");
      // Exactly the parent's two tasks: a shared project file must not be seeded twice.
      expect(host.widgetLines()[0]).toContain("2 tasks");
    },
  );

  it("carries the parent's tasks into a fork of a session Pi does not persist", async () => {
    host = await startPiHost({ persistSession: false });
    await createTwoTasks(host);
    await host.fork();
    expect(host.widgetLines()[0]).toContain("2 tasks");
  });

  it("keeps a fork's tasks independent of its parent", async () => {
    host = await startPiHost();
    await createTwoTasks(host);
    const parentFile = host.runtime.session.sessionFile as string;
    const parentTaskFile = host.sessionTaskFile();
    await host.fork();
    host.respond(toolCalls(["TaskCreate", { subject: "Fork only", description: "x" }]), textReply("ok"));
    await host.prompt("add");
    expect(host.storedSubjects()).toEqual(["Alpha", "Beta", "Fork only"]);
    await host.runtime.switchSession(parentFile);
    expect(host.sessionTaskFile()).toBe(parentTaskFile);
    expect(host.storedSubjects()).toEqual(["Alpha", "Beta"]);
  });

  it("stops the replaced instance's spinner on /new", async () => {
    host = await startPiHost();
    await createTwoTasks(host);
    await host.runtime.newSession();
    const redraws = host.redraws();
    await sleep(500);
    expect(host.redraws()).toBe(redraws);
    expect(host.widgetLines()).toEqual([]);
  });

  it("restores tasks and task tools on /resume", async () => {
    host = await startPiHost();
    await createTwoTasks(host);
    const file = host.runtime.session.sessionFile as string;
    await host.runtime.newSession();
    await host.runtime.switchSession(file);
    expect(host.lifecycle).toContain("start:resume");
    expect(host.widgetLines()[0]).toContain("2 tasks");
    expect(host.runtime.session.getActiveToolNames()).toEqual(expect.arrayContaining(TASK_TOOLS));
  });

  it("keeps the task list across /reload and stops the old instance's spinner", async () => {
    host = await startPiHost();
    await createTwoTasks(host);
    await host.reload();
    const redraws = host.redraws();
    await sleep(500);
    expect(host.lifecycle).toContain("start:reload");
    expect(host.widgetLines()[0]).toContain("2 tasks");
    expect(host.redraws()).toBe(redraws);
    expect(host.errors).toEqual([]);
  });

  it("keeps memory-scope tasks across /reload", async () => {
    host = await startPiHost({ taskScope: "memory" });
    await createTwoTasks(host);
    await host.reload();
    expect(host.widgetLines()[0]).toContain("2 tasks");
    const listed = await listedByModel(host);
    expect(listed).toContain("Alpha");
    expect(listed).toContain("Beta");
  });

  it("keeps the tasks of a session Pi does not persist across /reload", async () => {
    host = await startPiHost({ persistSession: false });
    await createTwoTasks(host);
    await host.reload();
    expect(host.widgetLines()[0]).toContain("2 tasks");
  });
});
