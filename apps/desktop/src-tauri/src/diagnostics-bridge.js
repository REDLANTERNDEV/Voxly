((origin) => {
  if (window !== window.top || window.location.origin !== origin) return;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  Object.defineProperty(window, "__VOXLY_DESKTOP_DIAGNOSTICS_V1__", {
    configurable: false, writable: false,
    value: Object.freeze({ version: 1, async save(report) {
      if (window !== window.top || window.location.origin !== origin || typeof invoke !== "function") throw new Error("forbidden");
      return invoke("save_voice_diagnostics", { report });
    } })
  });
})
