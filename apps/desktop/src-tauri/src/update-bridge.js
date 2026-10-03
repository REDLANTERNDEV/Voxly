((origin) => {
  if (window !== window.top || window.location.origin !== origin) return;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  const listeners = new Set();
  const allowed = () => window === window.top && window.location.origin === origin && typeof invoke === "function";
  Object.defineProperty(window, "__VOXLY_DESKTOP_UPDATES_V1__", {
    configurable: false,
    writable: false,
    value: Object.freeze({
      version: 1,
      async read() { if (!allowed()) return null; return invoke("read_desktop_update"); },
      async review() {
        if (!allowed()) return false;
        try { await invoke("review_desktop_update"); return true; } catch { return false; }
      },
      subscribe(handler) {
        if (!allowed() || typeof handler !== "function") return () => {};
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
      dispatch(snapshot) {
        if (!allowed()) return;
        for (const handler of listeners) { try { handler(snapshot); } catch {} }
      }
    })
  });
})
