import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transpileModule, ScriptTarget, ModuleKind } from "typescript";
import { startupInstallation } from "../src/home.js";
import { translate } from "../src/i18n.js";

const source = readFileSync("src/main.ts", "utf8");
// Exercise the real launcher orchestration with the native event/IPC boundary
// replaced. No Windows webview or authenticated Installation is needed.
const startupSource = source.slice(source.indexOf("async function start()"), source.indexOf("\nvoid start();"));
const loadingSource = source.slice(source.indexOf("function renderLoading()"), source.indexOf('\nelement("cancel-connection")'));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flush() { await new Promise<void>((resolve) => setImmediate(resolve)); }

function boot(options: { updates?: () => Promise<unknown>; registration?: (event: string) => Promise<unknown>; connection?: Promise<unknown>; handoff?: boolean; tray?: boolean } = {}) {
  const preferred = { id: "preferred", origin: "https://chat.example" };
  const snapshot = { active: null, shellVersion: "0.1.1", preferences: {
    language: "en", installations: [preferred], defaultInstallationId: preferred.id,
    openOnStartup: true, trayAcknowledged: true
  } };
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const connections: unknown[] = [];
  const calls: string[] = [];
  const classes = new Set<string>();
  const nodes = new Map<string, { textContent: string; hidden: boolean; focus(): void; scrollIntoView(): void }>();
  const context: Record<string, any> = {
    native: true, state: null, language: "en", updateState: null, pendingDesktopLink: null,
    booting: true, loadingTarget: null, receivedReady: null, failedConnection: null, confirmPending: false,
    connectionRevision: 0, attemptedConnection: null,
    document: { body: { classList: { toggle(name: string, enabled: boolean) { if (enabled) classes.add(name); else classes.delete(name); } } } },
    renderTranslations() {}, renderInstallations() { context.renderLoading(); }, refreshReport() {},
    renderUpdates() {}, status(message: string) { calls.push(`status:${message}`); }, errorKey: () => "window_failed",
    t: (key: Parameters<typeof translate>[1]) => translate("en", key), startupInstallation,
    location: { search: "" }, URLSearchParams,
    element(id: string) {
      if (!nodes.has(id)) nodes.set(id, { textContent: "", hidden: false, focus() {}, scrollIntoView() {} });
      return nodes.get(id);
    },
    async listen(event: string, handler: (event: { payload: unknown }) => void) {
      calls.push(`listen:${event}`);
      await options.registration?.(event);
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    async invoke(command: string) {
      calls.push(command);
      if (command === "shell_state") return snapshot;
      if (command === "shell_update_state") return options.updates?.() ?? { phase: "current" };
      if (command === "take_tray_update_check") return options.tray ?? false;
      if (command === "connect_installation") return options.connection;
      if (command === "cancel_connection") return snapshot;
      throw new Error(`Unexpected command: ${command}`);
    },
    async receiveDesktopLink() { calls.push("handoff"); return options.handoff ?? false; },
    async connect(saved: unknown) { connections.push(saved); }, quit() {}, run() {}
  };
  const javascript = transpileModule(`${loadingSource}\n${startupSource}`.replaceAll("import.meta.env.DEV", "false"), {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext }
  }).outputText;
  const finished = runInNewContext(`${javascript}\nstart();`, context) as Promise<void>;
  return { context, calls, handlers, connections, preferred, nodes, classes, finished };
}

test("startup connects without waiting for updater presentation, including failed reads", async () => {
  const pending = deferred<unknown>();
  const delayed = boot({ updates: () => pending.promise });
  await flush();
  assert.deepEqual(delayed.connections, [delayed.preferred]);
  await delayed.finished;
  assert.ok(delayed.calls.indexOf("listen:shell:updates") < delayed.calls.indexOf("shell_update_state"));
  pending.resolve({ phase: "current" });
  await flush();
  assert.equal(delayed.context.updateState.phase, "current");

  const failed = boot({ updates: async () => { throw new Error("unavailable"); } });
  await failed.finished;
  assert.deepEqual(failed.connections, [failed.preferred]);
  assert.equal(failed.context.updateState.phase, "error");
  assert.equal(failed.context.updateState.error, "update_unavailable");
  assert.ok(!failed.calls.includes("status:window_failed"));
});

test("published updater state wins over a delayed initial read", async () => {
  const pending = deferred<unknown>();
  const launched = boot({ updates: () => pending.promise });
  await launched.finished;
  launched.handlers.get("shell:updates")!({ payload: { phase: "downloading", downloaded: 1024 } });
  pending.resolve({ phase: "available" });
  await flush();
  assert.equal(launched.context.updateState.phase, "downloading");
  assert.equal(launched.context.updateState.downloaded, 1024);
});

test("handoff and tray update intent each take priority over the default Installation", async () => {
  for (const options of [{ handoff: true }, { tray: true }]) {
    const launched = boot(options);
    await launched.finished;
    assert.deepEqual(launched.connections, []);
  }
});

test("opening feedback lasts until ready, cancellation discards late completion, and failures recover", async () => {
  const pending = deferred<unknown>();
  const launched = boot({ connection: pending.promise });
  await launched.finished;
  const opening = launched.context.openConnection(launched.preferred, {});
  assert.ok(launched.classes.has("is-loading"));
  assert.equal(launched.nodes.get("loading-origin")!.textContent, launched.preferred.origin);
  assert.equal(launched.nodes.get("cancel-connection")!.hidden, false);
  await launched.context.cancelLoading();
  assert.ok(!launched.classes.has("is-loading"));
  pending.resolve({ active: launched.preferred, loading: true });
  assert.equal(await opening, undefined);
  assert.equal(launched.context.state.active, null);

  const current = boot({ connection: Promise.resolve({ active: launched.preferred, loading: true }) });
  await current.finished;
  await current.context.openConnection(current.preferred, {});
  assert.ok(current.classes.has("is-loading"));
  current.handlers.get("shell:ready")!({ payload: { active: current.preferred, loading: false } });
  assert.ok(!current.classes.has("is-loading"));
  await current.context.openConnection(current.preferred, {});
  current.handlers.get("shell:load-failed")!({ payload: current.preferred });
  assert.ok(!current.classes.has("is-loading"));
  assert.equal(current.context.failedConnection, current.preferred);
  assert.ok(current.nodes.get("status")!.textContent.includes(translate("en", "connectionFailed")));
  await flush();
});

test("startup registers independent listeners together and waits before choosing an Installation", async () => {
  const ready = deferred<unknown>();
  const launched = boot({ registration: (event) => event === "shell:ready" ? ready.promise : Promise.resolve() });
  await flush();
  for (const event of ["shell:ready", "shell:show-home", "shell:check-update", "shell:load-failed", "shell:preferences", "shell:quit-requested", "shell:updates", "shell:review-update"]) {
    assert.ok(launched.calls.includes(`listen:${event}`), `${event} registration is blocked by another listener`);
  }
  assert.ok(!launched.calls.includes("handoff"));
  assert.deepEqual(launched.connections, []);
  ready.resolve(undefined);
  await launched.finished;
  assert.deepEqual(launched.connections, [launched.preferred]);
  assert.ok(launched.calls.indexOf("listen:shell:desktop-link") < launched.calls.indexOf("shell_state"));
});
