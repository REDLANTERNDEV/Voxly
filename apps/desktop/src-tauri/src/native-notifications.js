((origin) => {
  if (window !== window.top || window.location.origin !== origin) return;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== "function" || typeof window.crypto?.randomUUID !== "function") return;
  const kinds = new Set(["message", "voicePeerJoin", "voicePeerLeave", "screenShareStart", "screenShareStop", "connectionLost", "connectionRestored"]);
  const handles = new Map();
  const current = () => window === window.top && window.location.origin === origin;
  window.addEventListener("voxly:native-notification", (event) => {
    if (!current()) return;
    const detail = event.detail;
    const handle = handles.get(detail?.id);
    if (!handle) return;
    if (detail.event === "click") handle.onclick?.(event);
    else if (detail.event === "close") { handles.delete(detail.id); handle.onclose?.(event); }
    else if (detail.event === "failed") handle.onfailure?.();
  });
  Object.defineProperty(window, "__VOXLY_DESKTOP_TOASTS_V1__", {
    configurable: false, writable: false,
    value: Object.freeze({
      version: 1,
      create(kind, language) {
        if (!current() || !kinds.has(kind) || !["en", "tr"].includes(language) || handles.size >= 16) throw new Error("invalid_notification");
        const id = window.crypto.randomUUID().replaceAll("-", "");
        let closed = false;
        const delivery = invoke("show_desktop_notification", { request: { id, kind, language } })
          .then((result) => ["shown", "blocked", "fallback"].includes(result) ? result : "fallback")
          .catch(() => "fallback");
        const handle = {
          delivery, onclick: null, onclose: null, onfailure: null,
          close() {
            if (closed) return;
            closed = true;
            handles.delete(id);
            handle.onclick = handle.onclose = handle.onfailure = null;
            // Closing while send is pending must also remove the eventual toast.
            void delivery.then(() => {
              if (current()) return invoke("close_desktop_notification", { id }).catch(() => {});
            });
          }
        };
        handles.set(id, handle);
        return handle;
      }
    })
  });
})
