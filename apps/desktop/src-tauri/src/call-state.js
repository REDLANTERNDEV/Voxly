((origin) => {
  if (window !== window.top || window.location.origin !== origin) return;
  // Capture only the transport for the one ACL-approved reporting command.
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  let provider = null;
  const keys = ["inVoice", "microphone", "camera", "screen", "computerAudio", "capture", "pendingJoin", "pendingCapture", "microphoneTest"];
  Object.defineProperty(window, "__VOXLY_DESKTOP_STATE_V1__", {
    configurable: false,
    writable: false,
    value: Object.freeze({
      version: 1,
      subscribe(handler) {
        if (typeof handler !== "function") return () => {};
        const lease = { handler };
        provider = lease;
        return () => { if (provider === lease) provider = null; };
      },
      request(request) {
        if (window !== window.top || window.location.origin !== origin || !provider || typeof invoke !== "function") return;
        if (!Number.isInteger(request) || request < 1 || request > 4294967295) return;
        try {
          const state = provider.handler();
          if (state?.version !== 1 || !keys.every((key) => typeof state[key] === "boolean")) return;
          const report = { version: 1 };
          for (const key of keys) report[key] = state[key];
          Promise.resolve(invoke("report_call_state", { request, report })).catch(() => {});
        } catch { /* Missing/failed reporting requires conservative confirmation. */ }
      }
    })
  });
})
