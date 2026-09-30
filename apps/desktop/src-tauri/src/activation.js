((origin) => {
  if (window !== window.top || window.location.origin !== origin) return;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  Object.defineProperty(window, "__VOXLY_DESKTOP_ACTIVATION_V1__", {
    configurable: false,
    writable: false,
    value: Object.freeze({
      version: 1,
      async show() {
        if (window !== window.top || window.location.origin !== origin || typeof invoke !== "function") return false;
        try { await invoke("activate_installation"); return true; }
        catch { return false; }
      }
    })
  });
})
