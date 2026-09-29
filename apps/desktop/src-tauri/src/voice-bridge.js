((origin) => {
  if (window !== window.top || window.location.origin !== origin) return;
  let receiver = null;
  // This object has no IPC, file, registration, or other native operation.
  Object.defineProperty(window, "__VOXLY_DESKTOP_V1__", {
    configurable: false,
    writable: false,
    value: Object.freeze({
      version: 1,
      subscribeMute(handler) {
        if (typeof handler !== "function") return () => {};
        const lease = { handler };
        receiver = lease;
        return () => { if (receiver === lease) receiver = null; };
      },
      dispatchMute() {
        if (window !== window.top || window.location.origin !== origin) return;
        receiver?.handler();
      }
    })
  });
})
