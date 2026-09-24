/**
 * pi-tasks with the real @tintinweb/pi-subagents, in a real Pi runtime.
 *
 * pi-subagents is not a dependency of this repository. The suite loads it from
 * `PI_SUBAGENTS_DIR`, or from a `pi-subagents` checkout next to this one, and is
 * skipped when neither exists, as in CI. An explicit `PI_SUBAGENTS_DIR` that holds no
 * pi-subagents fails the run instead: skipping a suite someone asked for would hide
 * the gap. The checkout needs its own `npm install`.
 *
 * One scripted model answers the parent and every subagent. A request is a
 * subagent's when its transcript carries the prompt `TaskExecute` builds.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ModelRequest, PI_TASKS_ENTRY, type PiHost, startPiHost, textReply, toolCalls } from "./helpers/pi-host.js";

function findSubagents(): string | undefined {
  const explicit = process.env.PI_SUBAGENTS_DIR;
  const dir = explicit ?? fileURLToPath(new URL("../../pi-subagents", import.meta.url));
  const manifest = join(dir, "package.json");
  const pkg = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : undefined;
  if (pkg?.name === "@tintinweb/pi-subagents") return resolve(dir, pkg.pi.extensions[0]);
  if (explicit) throw new Error(`PI_SUBAGENTS_DIR=${explicit} holds no @tintinweb/pi-subagents checkout`);
  return undefined;
}

const SUBAGENTS_ENTRY = findSubagents();

/** pi-subagents' `SESSION_ENDED_ERROR`: the error of an agent cut short by the session's end. */
const SESSION_ENDED = "The session ended before the agent finished.";

/** Both load orders. Pi runs session_shutdown handlers in load order, and pi-subagents
 *  reports the agents it aborts from its own handler. */
const LOAD_ORDERS = {
  "pi-subagents first": () => [SUBAGENTS_ENTRY as string, PI_TASKS_ENTRY],
  "pi-tasks first": () => [PI_TASKS_ENTRY, SUBAGENTS_ENTRY as string],
};
type LoadOrder = keyof typeof LOAD_ORDERS;

const isSubagent = (request: ModelRequest) => request.transcript.includes("You are executing task #");

/** A subagent reply that never comes: the request ends only when it is aborted. */
function heldUntilAborted(signal?: AbortSignal) {
  return new Promise<ReturnType<typeof textReply>>(resolve => {
    signal?.addEventListener("abort", () => resolve(textReply("never")), { once: true });
  });
}

/** The parent's side: "delegate" creates task #1 for a subagent and executes it. */
function parent(request: ModelRequest, afterLaunch?: () => ReturnType<typeof toolCalls>) {
  const last = request.lastText;
  if (last === "delegate") {
    return toolCalls(["TaskCreate", { subject: "Survey", description: "Survey the module.", agentType: "general-purpose" }]);
  }
  if (last.startsWith("Task #1 created")) return toolCalls(["TaskExecute", { task_ids: ["1"] }]);
  if (last.startsWith("Launched") && afterLaunch) return afterLaunch();
  if (last === "stop") return toolCalls(["TaskStop", { task_id: "1" }]);
  if (last === "check") return toolCalls(["TaskGet", { taskId: "1" }]);
  return textReply("ok");
}

let host: PiHost | undefined;
afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

async function start(order: LoadOrder = "pi-subagents first", options: { taskScope?: "memory"; autoCascade?: boolean } = {}) {
  host = await startPiHost({ ...options, extensions: LOAD_ORDERS[order]() });
  expect(host.loadErrors()).toEqual([]);
  return host;
}

/** Delegate task #1 to a subagent that runs until something aborts it. */
async function delegateLongRunning(h: PiHost) {
  let started = false;
  h.respondWith((request, signal) => {
    if (!isSubagent(request)) return parent(request);
    started = true;
    return heldUntilAborted(signal);
  });
  await h.prompt("delegate");
  await vi.waitFor(() => expect(started).toBe(true));
  expect(h.widgetLines()[0]).toContain("1 in progress");
}

/** Task #1 as the model sees it through TaskGet in the current session. */
async function taskAsSeenByModel(h: PiHost): Promise<string> {
  await h.prompt("check");
  return h.requests[h.requests.length - 1].lastToolResult ?? "";
}

describe.skipIf(!SUBAGENTS_ENTRY)("pi-tasks with the real pi-subagents", { timeout: 30_000 }, () => {
  it("completes the protocol handshake and launches a subagent", async () => {
    const h = await start();
    h.respondWith(request => (isSubagent(request) ? textReply("SURVEY DONE") : parent(request)));
    await h.prompt("delegate");
    expect(h.requests.some(request => request.lastText.startsWith("Launched 1 agent(s)"))).toBe(true);
    expect(h.notices).toEqual([]);
  });

  it("closes the task with the subagent's result, which TaskOutput returns in the same turn", async () => {
    const h = await start();
    h.respondWith(request =>
      isSubagent(request)
        ? textReply("SURVEY DONE")
        : parent(request, () => toolCalls(["TaskOutput", { task_id: "1", block: true, timeout: 10_000 }])),
    );
    await h.prompt("delegate");
    expect(h.storedTasks()[0]).toMatchObject({ status: "completed", metadata: { result: "SURVEY DONE" } });
    expect(h.requests.some(request => request.lastToolResult?.includes("SURVEY DONE"))).toBe(true);
    // TaskOutput consumed the result, so pi-subagents must not announce it again.
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(h.requests.some(request => request.lastText.includes("<task-notification>"))).toBe(false);
  });

  it("reverts the task to pending with the error when its subagent fails", async () => {
    const h = await start();
    h.respondWith(request =>
      isSubagent(request) ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "child exploded" }) : parent(request),
    );
    await h.prompt("delegate");
    await vi.waitFor(() => expect(h.storedTasks()[0]?.status).toBe("pending"));
    expect(h.storedTasks()[0].metadata.lastError).toBe("child exploded");
  });

  it("stops a running subagent with TaskStop and keeps the task completed", async () => {
    const h = await start();
    await delegateLongRunning(h);
    await h.prompt("stop");
    expect(h.requests[h.requests.length - 1].lastToolResult).toBe("Task #1 stopped successfully");
    // pi-subagents reports the stop as `stopped`; the task must stay completed.
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(h.storedTasks()[0].status).toBe("completed");
  });

  it("auto-cascades into the dependent task, handing it the first task's result", async () => {
    const h = await start("pi-subagents first", { autoCascade: true });
    h.respondWith(request => {
      if (isSubagent(request)) {
        return request.transcript.includes("executing task #1")
          ? textReply("RESULT-A")
          : textReply(request.transcript.includes("RESULT-A") ? "B saw A" : "B missed A");
      }
      const last = request.lastText;
      if (last === "chain") {
        return toolCalls(
          ["TaskCreate", { subject: "A", description: "first", agentType: "general-purpose" }],
          ["TaskCreate", { subject: "B", description: "second", agentType: "general-purpose" }],
        );
      }
      if (last.startsWith("Task #2 created")) return toolCalls(["TaskUpdate", { taskId: "2", addBlockedBy: ["1"] }]);
      if (last.startsWith("Updated task #2")) return toolCalls(["TaskExecute", { task_ids: ["1"] }]);
      return textReply("ok");
    });
    await h.prompt("chain");
    await vi.waitFor(() => expect(h.storedTasks().map(task => task.status)).toEqual(["completed", "completed"]));
    expect(h.storedTasks().map(task => task.metadata.result)).toEqual(["RESULT-A", "B saw A"]);
  });

  // pi-subagents aborts every agent when a session ends. The task must go back to
  // pending, with the reason, wherever it now lives; never stay in_progress on an
  // agent that no longer exists.
  describe.each(Object.keys(LOAD_ORDERS) as LoadOrder[])("a subagent cut short by the session's end (%s)", order => {
    const endedByTheSession = { status: "pending", metadata: { lastError: SESSION_ENDED } };

    it("/reload leaves the task pending in the reloaded session", async () => {
      const h = await start(order);
      await delegateLongRunning(h);
      await h.reload();
      expect(h.storedTasks()[0]).toMatchObject(endedByTheSession);
      expect(await taskAsSeenByModel(h)).toContain("Status: pending");
    });

    it("/fork leaves the task pending in the fork and in its parent", async () => {
      const h = await start(order);
      await delegateLongRunning(h);
      const parentFile = h.sessionTaskFile();
      await h.fork();
      expect(h.sessionTaskFile()).not.toBe(parentFile);
      expect(h.storedTasks()[0]).toMatchObject(endedByTheSession);
      expect(h.storedTasks(parentFile)[0]).toMatchObject(endedByTheSession);
    });

    it("/new leaves the task pending in the session it left", async () => {
      const h = await start(order);
      await delegateLongRunning(h);
      const oldFile = h.sessionTaskFile();
      await h.runtime.newSession();
      expect(h.storedTasks()).toEqual([]);
      expect(h.storedTasks(oldFile)[0]).toMatchObject(endedByTheSession);
    });

    it("quitting leaves the task pending in the session's file", async () => {
      const h = await start(order);
      await delegateLongRunning(h);
      const file = h.sessionTaskFile();
      await h.runtime.dispose();
      expect(h.storedTasks(file)[0]).toMatchObject(endedByTheSession);
    });

    it.each(["reload", "fork"] as const)("/%s carries a memory-scope task over as pending", async transition => {
      const h = await start(order, { taskScope: "memory" });
      await delegateLongRunning(h);
      await (transition === "reload" ? h.reload() : h.fork());
      const seen = await taskAsSeenByModel(h);
      expect(seen).toContain("Status: pending");
      expect(seen).toContain(SESSION_ENDED);
    });
  });
});
