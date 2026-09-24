/**
 * TaskWidget teardown and failure isolation.
 *
 * The widget's spinner runs on its own timer, and an exception escaping a timer is
 * uncaught: Pi's interactive mode exits on it. Every other caller of `update()` has
 * just changed the store, and must not be told the change failed because a redraw did.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";
import { TaskWidget, type Theme, type UICtx } from "../src/ui/task-widget.js";

const theme: Theme = { fg: (_c, text) => text, bold: text => text, strikethrough: text => text };

/** A UI whose setWidget renders the registered component once, like Pi does. */
function mockUI(tui: { terminal: { columns: number }; requestRender(): void }) {
  const ui = {
    setWidget: vi.fn((_key: string, content: any) => { if (content) content(tui, theme); }),
    setStatus: vi.fn(),
  };
  return ui as typeof ui & UICtx;
}

let store: TaskStore;
let onError: ReturnType<typeof vi.fn>;
let widget: TaskWidget;

beforeEach(() => {
  vi.useFakeTimers();
  store = new TaskStore();
  onError = vi.fn();
  widget = new TaskWidget(store, {}, onError);
});

afterEach(() => {
  widget.dispose();
  vi.useRealTimers();
});

/** Task #1 in progress with its spinner running. */
function spin(ui: UICtx) {
  widget.setUICtx(ui);
  store.create("Busy", "d");
  store.update("1", { status: "in_progress" });
  widget.setActiveTask("1");
}

describe("TaskWidget.dispose", () => {
  it("stops the timer and leaves nothing that can reach the UI", () => {
    const ui = mockUI({ terminal: { columns: 80 }, requestRender: vi.fn() });
    spin(ui);
    expect(vi.getTimerCount()).toBe(1);

    widget.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(ui.setWidget).toHaveBeenLastCalledWith("tasks", undefined);

    const calls = ui.setWidget.mock.calls.length;
    store.create("Late", "d");
    store.update("2", { status: "in_progress" });
    widget.setActiveTask("2");
    widget.update();
    vi.advanceTimersByTime(1_000);
    expect(ui.setWidget.mock.calls.length).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("draws again once a UI is handed back", () => {
    const ui = mockUI({ terminal: { columns: 80 }, requestRender: vi.fn() });
    spin(ui);
    widget.dispose();
    widget.setUICtx(ui);
    widget.update();
    expect(ui.setWidget).toHaveBeenLastCalledWith("tasks", expect.any(Function), { placement: "aboveEditor" });
  });

  it("swallows a UI that fails while the widget is cleared", () => {
    const ui = mockUI({ terminal: { columns: 80 }, requestRender: vi.fn() });
    spin(ui);
    ui.setWidget.mockImplementation(() => { throw new Error("UI gone"); });
    expect(() => widget.dispose()).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "UI gone" }));
  });
});

describe("TaskWidget timer", () => {
  it("starts no timer without a UI", () => {
    store.create("Busy", "d");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1");
    widget.ensureTimer();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the spinner instead of letting a failed redraw escape the tick", () => {
    const requestRender = vi.fn();
    spin(mockUI({ terminal: { columns: 80 }, requestRender }));
    requestRender.mockImplementation(() => { throw new Error("renderer stopped"); });
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "renderer stopped" }));
  });
});

describe("TaskWidget.update", () => {
  it("never throws, and retries on the next update", () => {
    const ui = mockUI({ terminal: { columns: 80 }, requestRender: vi.fn() });
    widget.setUICtx(ui);
    store.create("Task", "d");
    ui.setWidget.mockImplementationOnce(() => { throw new Error("UI busy"); });
    expect(() => widget.update()).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);

    widget.update();
    expect(ui.setWidget).toHaveBeenLastCalledWith("tasks", expect.any(Function), { placement: "aboveEditor" });
  });
});
