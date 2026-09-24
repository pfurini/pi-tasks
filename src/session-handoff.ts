/**
 * session-handoff.ts — Carries a task list from one extension instance to the next.
 *
 * Pi runs the extension factory again for every session it starts: `/new`,
 * `/resume`, `/fork` and `/reload` each get a fresh instance with a fresh store.
 * Two transitions must keep the old instance's tasks, and the old instance is the
 * only thing that still holds them: a fork starts from its parent's list, and a
 * reload of an in-memory list has no file to re-read. The old instance leaves a
 * handoff on `session_shutdown`; the new instance takes it on `session_start`.
 *
 * A handoff is read when it is taken, not when it is left. Other extensions shut
 * down after this one when they load later, and one of them can still change a
 * task: pi-subagents reports the agents it aborts at the end of the session, and
 * the task they ran for goes back to pending. Taken at `session_start`, the copy
 * includes that change whatever the load order.
 *
 * The registry lives on `globalThis`, not in module scope: Pi may evaluate this
 * module again for the new instance, and module state would not survive that.
 */

import type { TaskStoreData } from "./types.js";

export interface SessionHandoff {
  /** File backing the store the tasks came from; undefined for an in-memory store. */
  sourcePath: string | undefined;
  data: TaskStoreData;
}

interface PendingHandoff {
  sourcePath: string | undefined;
  /** Reads the old instance's store as it stands when the handoff is taken. */
  read: () => TaskStoreData;
}

const REGISTRY_KEY = Symbol.for("@tintinweb/pi-tasks:session-handoff");

function registry(): Map<string, PendingHandoff> {
  const holder = globalThis as { [REGISTRY_KEY]?: Map<string, PendingHandoff> };
  holder[REGISTRY_KEY] ??= new Map();
  return holder[REGISTRY_KEY];
}

/** Key naming the session a handoff is for: its session file, or its workspace when
 *  Pi is not persisting the session (`pi --no-session`). */
export function handoffKey(sessionFile: string | undefined, cwd: string): string {
  return sessionFile ?? `in-memory:${cwd}`;
}

/** Leave a handoff for the session named by `key`. A later one for the same key
 *  replaces it. */
export function leaveHandoff(key: string, handoff: PendingHandoff): void {
  registry().set(key, handoff);
}

/** Remove the handoff for `key`, if one is waiting, and return a copy of the tasks
 *  as they stand now. */
export function takeHandoff(key: string): SessionHandoff | undefined {
  const pending = registry().get(key);
  if (!pending) return undefined;
  registry().delete(key);
  return { sourcePath: pending.sourcePath, data: structuredClone(pending.read()) };
}
