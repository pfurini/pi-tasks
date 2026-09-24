/**
 * A real Pi session runtime for integration tests.
 *
 * `mock-pi.ts` drives src/index.ts through a fake ExtensionAPI with one extension
 * instance. That cannot show what Pi itself does between sessions: Pi runs the
 * extension factory again for every session it starts, and every bug that lives in
 * that gap (a fork losing its tasks, a timer outliving its session) was invisible
 * to it. This harness boots the Pi runtime from the installed
 * `@earendil-works/pi-coding-agent`, loads pi-tasks from its source path the way Pi
 * loads an installed package, and scripts the model with pi-ai's faux provider.
 *
 * The faux stream reaches Pi through `registerProvider({ streamSimple })`, not through
 * pi-ai's provider registry: npm installs a second copy of pi-ai under pi-coding-agent,
 * and a registration made in the test's copy is invisible to the host. The faux
 * provider still comes from the pinned pi-ai, which matches the host's release because
 * it reads the host's message shapes.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AssistantMessage,
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type JsonObject,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionAPI,
  type ExtensionUIContext,
  initTheme,
  type ProviderConfig,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

/** pi-tasks' extension entry, loaded from source the way Pi loads an installed package. */
export const PI_TASKS_ENTRY = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

// Interactive Pi initializes its theme at startup; the settings panel reads it.
initTheme();

/** Every ExtensionUIContext method. The runner copies the UI object with a spread, so
 *  the stub must be a plain object with own properties, not a Proxy. */
const UI_METHODS = [
  "addAutocompleteProvider", "confirm", "custom", "editor", "getAllThemes", "getEditorComponent",
  "getEditorText", "getTheme", "getToolsExpanded", "input", "notify", "onTerminalInput", "pasteToEditor",
  "select", "setEditorComponent", "setEditorText", "setFooter", "setHeader", "setHiddenThinkingLabel",
  "setStatus", "setTheme", "setTitle", "setToolsExpanded", "setWidget", "setWorkingIndicator",
  "setWorkingMessage", "setWorkingVisible",
];

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
};

type Renderable = { render(width: number): string[] };
type WidgetFactory = (tui: unknown, theme: typeof plainTheme) => Renderable;
type CustomFactory = (tui: unknown, theme: typeof plainTheme, keybindings: unknown, done: (value: unknown) => void) => Renderable;

/** The fields of a persisted task the tests read. */
export interface StoredTask {
  id: string;
  subject: string;
  status: string;
  owner?: string;
  metadata: Record<string, unknown>;
}

/** What one model request carried. */
export interface ModelRequest {
  /** Tool names the request declared, from its system messages. */
  tools: string[];
  /** Text of the request's last message. */
  lastText: string;
  /** Text of the latest tool result in the request, if any. */
  lastToolResult: string | undefined;
  /** Text of every user message and tool result in the request, in order. */
  transcript: string;
}

export interface PiHostOptions {
  /** Written to `<cwd>/.pi/tasks-config.json` when set. */
  taskScope?: "session" | "session-global" | "memory" | "project";
  /** Written to `<cwd>/.pi/tasks-config.json` when set. */
  autoCascade?: boolean;
  /** False starts a session Pi keeps in memory only, as `pi --no-session` does. */
  persistSession?: boolean;
  /** Extension entry files, loaded in this order. Defaults to pi-tasks alone. */
  extensions?: string[];
}

function textOf(message: Message | undefined): string {
  if (!message || message.role === "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

/** A scripted reply that calls tools, one call per `[name, args]` pair. */
export function toolCalls(...calls: Array<[string, JsonObject]>): AssistantMessage {
  return fauxAssistantMessage(calls.map(([name, args]) => fauxToolCall(name, args)), { stopReason: "toolUse" });
}

/** A scripted text-only reply. */
export function textReply(text: string): AssistantMessage {
  return fauxAssistantMessage(text);
}

export async function startPiHost(options: PiHostOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-tasks-host-"));
  const cwd = join(root, "work");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const tasksConfig = { taskScope: options.taskScope, autoCascade: options.autoCascade };
  if (Object.values(tasksConfig).some(value => value !== undefined)) {
    writeFileSync(join(cwd, ".pi", "tasks-config.json"), JSON.stringify(tasksConfig));
  }

  // ── Model ──
  const faux = createFauxCore({ provider: "pi-tasks-test", api: "pi-tasks-test-api" });
  const model = faux.getModel();
  const requests: ModelRequest[] = [];
  const record = ({ messages }: TranscriptContext) => {
    const toolResults = messages.filter(message => message.role === "toolResult").map(textOf);
    requests.push({
      tools: messages.flatMap(message => (message.role === "system" ? message.toolsAdded ?? [] : [])).map(tool => tool.name),
      lastText: textOf(messages[messages.length - 1]),
      lastToolResult: toolResults[toolResults.length - 1],
      transcript: messages.filter(message => message.role === "user" || message.role === "toolResult").map(textOf).join("\n"),
    });
  };
  const fauxExtension = (pi: ExtensionAPI) => {
    pi.registerProvider(model.provider, {
      baseUrl: "http://localhost",
      apiKey: "faux-key",
      api: model.api,
      // The test's pi-ai and the host's are separate installs, so their branded
      // context types are distinct to the compiler although they are the same at runtime.
      streamSimple: faux.streamSimple as unknown as ProviderConfig["streamSimple"],
      models: [{
        id: model.id,
        name: model.name,
        reasoning: false,
        input: ["text"],
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }],
    });
  };

  // ── Lifecycle recorder ──
  const lifecycle: string[] = [];
  const recorder = (pi: ExtensionAPI) => {
    pi.on("session_start", event => { lifecycle.push(`start:${event.reason}`); });
    pi.on("session_shutdown", event => { lifecycle.push(`shutdown:${event.reason}`); });
  };

  // ── UI ──
  let widget: Renderable | undefined;
  let redraws = 0;
  const selectAnswers: Array<string | undefined> = [];
  const selects: Array<{ title: string; options: string[] }> = [];
  const customRenders: string[][] = [];
  const notices: string[] = [];
  const tui = { terminal: { columns: 100, rows: 40 }, requestRender: () => { redraws++; } };
  const ui: Record<string, unknown> = { theme: plainTheme };
  for (const method of UI_METHODS) ui[method] = () => undefined;
  ui.notify = (message: string) => { notices.push(message); };
  ui.setWidget = (key: string, content: WidgetFactory | undefined) => {
    if (key === "tasks") widget = content?.(tui, plainTheme);
  };
  ui.select = async (title: string, choices: string[]) => {
    selects.push({ title, options: choices });
    return selectAnswers.shift();
  };
  ui.custom = async (factory: CustomFactory) => {
    let result: unknown;
    const component = factory(tui, plainTheme, {}, value => { result = value; });
    customRenders.push(component.render(100));
    return result;
  };
  const errors: unknown[] = [];
  const bindings = {
    uiContext: ui as unknown as ExtensionUIContext,
    onError: (error: unknown) => { errors.push(error); },
  };

  // ── Runtime ──
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        additionalExtensionPaths: options.extensions ?? [PI_TASKS_ENTRY],
        extensionFactories: [fauxExtension, recorder],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      },
    });
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model });
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: options.persistSession === false ? SessionManager.inMemory(cwd) : SessionManager.create(cwd),
  });
  // Mirrors interactive mode: widgets are cleared before a session is replaced, and
  // the replacement is bound to the same UI.
  runtime.setBeforeSessionInvalidate(() => { widget = undefined; });
  runtime.setRebindSession(async session => { await session.bindExtensions(bindings); });
  await runtime.session.bindExtensions(bindings);

  const sessionTaskFile = () =>
    join(cwd, ".pi", "tasks", `tasks-${runtime.session.sessionManager.getSessionId()}.json`);
  const storedTasks = (file = sessionTaskFile()): StoredTask[] =>
    existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).tasks : [];

  return {
    runtime,
    cwd,
    requests,
    lifecycle,
    errors,
    selectAnswers,
    selects,
    customRenders,
    /** Messages the extensions passed to `ui.notify`. */
    notices,
    /** Queue the model's replies for the next prompt, one per model request. */
    respond(...replies: AssistantMessage[]) {
      faux.setResponses(replies.map(reply => (context: TranscriptContext) => { record(context); return reply; }));
    },
    /** Answer every model request, the parent's and any subagent's, with `responder`.
     *  A reply may be a promise: the request stays in flight until it settles. `signal`
     *  is the request's abort signal; a reply that waits must end when it aborts, as a
     *  real provider's stream does. */
    respondWith(
      responder: (request: ModelRequest, signal?: AbortSignal) => AssistantMessage | Promise<AssistantMessage>,
    ) {
      const step = (context: TranscriptContext, streamOptions?: { signal?: AbortSignal }) => {
        record(context);
        return responder(requests[requests.length - 1], streamOptions?.signal);
      };
      faux.setResponses(Array.from({ length: 200 }, () => step));
    },
    prompt(text: string) {
      return runtime.session.prompt(text);
    },
    /** Reload as interactive mode's /reload does: extension widgets are cleared first,
     *  so the widget on screen afterwards is the one the reloaded instance draws. */
    reload() {
      widget = undefined;
      return runtime.session.reload();
    },
    /** Fork the current session at its latest entry, as `/fork` does. */
    fork() {
      const leaf = runtime.session.sessionManager.getLeafId();
      if (!leaf) throw new Error("nothing to fork: the session has no entries");
      return runtime.fork(leaf, { position: "at" });
    },
    /** Lines the tasks widget currently renders; empty when none is registered. */
    widgetLines(): string[] {
      return widget ? widget.render(100) : [];
    },
    /** Redraw requests made through the TUI so far. */
    redraws(): number {
      return redraws;
    },
    /** The current session's task file under the default `session` scope. */
    sessionTaskFile,
    /** Tasks stored in `file`, by default the current session's task file under the
     *  `session` scope; empty when there is none. */
    storedTasks,
    /** Subjects stored in the current session's task file; empty when there is none. */
    storedSubjects(): string[] {
      return storedTasks().map(task => task.subject);
    },
    /** Extensions that failed to load in the current session, with their errors. */
    loadErrors() {
      return runtime.services.resourceLoader.getExtensions().errors;
    },
    async dispose() {
      await runtime.dispose().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export type PiHost = Awaited<ReturnType<typeof startPiHost>>;
