/** Prefer above the anchor and clamp even at high display scaling. */
export function menuPosition(anchor: { top: number; bottom: number; right: number }, size: { width: number; height: number }, viewport: { width: number; height: number }) {
  const margin = 8, gap = 6;
  const height = Math.min(size.height, Math.max(0, viewport.height - margin * 2));
  const above = anchor.top - gap - height;
  const top = above >= margin ? above : Math.min(anchor.bottom + gap, viewport.height - margin - height);
  return { left: Math.max(margin, Math.min(anchor.right - size.width, viewport.width - margin - size.width)), top: Math.max(margin, top), maxHeight: viewport.height - margin * 2 };
}

export function installationMenus(document: Document, window: Window) {
  const openMenus = () => [...document.querySelectorAll<HTMLDetailsElement>(".installation-menu[open]")];
  const place = (menu: HTMLDetailsElement) => {
    const trigger = menu.querySelector<HTMLElement>("summary")!;
    const items = menu.querySelector<HTMLElement>(".installation-menu-items")!;
    const position = menuPosition(trigger.getBoundingClientRect(), items.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
    Object.assign(items.style, { left: `${position.left}px`, top: `${position.top}px`, maxHeight: `${position.maxHeight}px` });
  };
  const close = (menu: HTMLDetailsElement, restore = false) => {
    menu.open = false; menu.querySelector("summary")?.setAttribute("aria-expanded", "false");
    if (restore) menu.querySelector<HTMLElement>("summary")?.focus();
  };
  document.addEventListener("toggle", (event) => {
    if (!(event.target instanceof HTMLDetailsElement) || !event.target.matches(".installation-menu")) return;
    const menu = event.target;
    menu.querySelector("summary")?.setAttribute("aria-expanded", String(menu.open));
    if (menu.open) { for (const other of openMenus()) if (other !== menu) close(other); place(menu); }
  }, true);
  document.addEventListener("keydown", (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLDetailsElement>(".installation-menu") : null;
    if (!target) return;
    if (event.key === "Escape" && target.open) { event.preventDefault(); close(target, true); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); target.open = true; place(target);
    const buttons = [...target.querySelectorAll<HTMLButtonElement>(".installation-menu-items button:not(:disabled)")];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowUp" ? (current <= 0 ? buttons.length - 1 : current - 1) : (current + 1) % buttons.length;
    buttons[index]?.focus();
  });
  document.addEventListener("pointerdown", (event) => { for (const menu of openMenus()) if (!menu.contains(event.target as Node)) close(menu); });
  document.addEventListener("focusin", (event) => { for (const menu of openMenus()) if (!menu.contains(event.target as Node)) close(menu); });
  window.addEventListener("resize", () => openMenus().forEach(place));
  document.addEventListener("scroll", () => openMenus().forEach(place), true);
}
