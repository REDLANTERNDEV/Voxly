((origin) => {
  if (window !== window.top || window.location.origin !== origin) return;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  async function reset(command) {
    if (window !== window.top || window.location.origin !== origin || typeof invoke !== "function") return false;
    try { await invoke(command); return true; }
    catch { return false; }
  }
  Object.defineProperty(window, "__VOXLY_DESKTOP_MEDIA_PERMISSIONS_V1__", {
    configurable: false,
    writable: false,
    value: Object.freeze({
      version: 1,
      resetMicrophone: () => reset("reset_microphone_permission"),
      resetCamera: () => reset("reset_camera_permission")
    })
  });
})
