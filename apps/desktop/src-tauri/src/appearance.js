((origin) => {
  if (window !== window.top || window.location.origin !== origin) return;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== "function") return;
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const contrast = window.matchMedia("(forced-colors: active)");
  let previous;
  let retries = 0;
  const sync = (force = false) => {
    if (window !== window.top || window.location.origin !== origin) return;
    const selected = document.documentElement?.getAttribute("data-theme");
    let saved;
    try { saved = window.localStorage.getItem("voxly:theme"); } catch { /* OS fallback. */ }
    const choice = selected ?? saved;
    const theme = choice === "dark" || choice === "light" ? choice : system.matches ? "dark" : "light";
    if (!force && previous === theme) return;
    previous = theme;
    void invoke("set_installation_theme", { theme }).catch(() => {
      previous = undefined;
      // The installation may still be registering when its document starts.
      if (retries++ < 2) window.setTimeout(() => sync(), 200);
    });
  };
  new MutationObserver(() => sync()).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-theme"] });
  document.addEventListener("DOMContentLoaded", () => sync());
  system.addEventListener("change", () => sync());
  contrast.addEventListener("change", () => sync(true));
  window.addEventListener("focus", () => sync(true));
  sync();
})
