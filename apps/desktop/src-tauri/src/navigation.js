((origin) => {
  if (window !== window.top || window.location.origin !== origin) return;
  const history = window.history;
  const replace = history.replaceState.bind(history);
  const entries = [{ state: history.state, url: window.location.href }];
  let index = 0;
  const urlFor = (url) => new URL(url == null ? window.location.href : url, window.location.href);
  const inApp = (url) => new URL(url).pathname.startsWith("/app/");
  // Desktop route history belongs to this document. Traversing native history
  // can destroy its sockets, capture, and peer connections at a document edge.
  history.pushState = (state, title, url) => {
    const next = urlFor(url);
    // Preserve native same-origin validation and state cloning before mutation.
    replace(state, title, next.href);
    if (!inApp(entries[index].url) && inApp(next.href)) {
      entries.splice(0, entries.length, { state: history.state, url: next.href });
      index = 0;
      return;
    }
    entries.splice(index + 1);
    entries.push({ state: history.state, url: next.href });
    index++;
  };
  history.replaceState = (state, title, url) => {
    replace(state, title, url);
    entries[index] = { state: history.state, url: window.location.href };
  };
  const move = (delta) => {
    if (window !== window.top || window.location.origin !== origin) return;
    const next = index + delta;
    if (!Number.isInteger(next) || next < 0 || next >= entries.length || next === index) return;
    const entry = entries[next];
    replace(entry.state, "", entry.url);
    index = next;
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  };
  history.back = () => move(-1);
  history.forward = () => move(1);
  history.go = (delta = 0) => move(Number(delta));
  const recordedButtons = new Set();
  for (const type of ["mousedown", "mouseup", "auxclick"]) {
    window.addEventListener(type, (event) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (type === "mousedown" && window.__VOXLY_DESKTOP_SETTINGS_V1__?.recording) recordedButtons.add(event.button);
      if (type === "mouseup" && !recordedButtons.has(event.button)) move(event.button === 3 ? -1 : 1);
      if (type === "auxclick") recordedButtons.delete(event.button);
    }, true);
  }
  window.addEventListener("keydown", (event) => {
    const back = event.code === "BrowserBack" || (event.altKey && event.code === "ArrowLeft");
    const forward = event.code === "BrowserForward" || (event.altKey && event.code === "ArrowRight");
    if (!back && !forward) return;
    event.preventDefault();
    move(back ? -1 : 1);
  }, true);
})
