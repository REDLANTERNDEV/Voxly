((origin) => {
  if (window !== window.top || window.location.origin !== origin) return;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  let recording = false;
  Object.defineProperty(window, "__VOXLY_DESKTOP_SETTINGS_V1__", {
    configurable: false, writable: false,
    value: Object.freeze({ version: 1, get recording() { return recording; }, async apply(operation) {
      if (window !== window.top || window.location.origin !== origin || typeof invoke !== "function") throw new Error("forbidden");
      if (operation?.kind === "recording" && typeof operation.enabled === "boolean") recording = operation.enabled;
      return invoke("desktop_settings", { operation });
    } })
  });
})
