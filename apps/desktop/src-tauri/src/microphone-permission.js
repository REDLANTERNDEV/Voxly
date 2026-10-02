((origin) => {
  if (window !== window.top || window.location.origin !== origin) return;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  Object.defineProperty(window, "__VOXLY_DESKTOP_MICROPHONE_V1__", {
    configurable: false, writable: false,
    value: Object.freeze({ version: 1, async resetPermission() {
      if (window !== window.top || window.location.origin !== origin || typeof invoke !== "function") return false;
      try { await invoke("reset_microphone_permission"); return true; }
      catch { return false; }
    } })
  });
})
