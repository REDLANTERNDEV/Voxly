import type { Translate } from "../app/types.js";

export function AppShellSkeleton({ t }: { t: Translate }) {
  return (
    <main className="app-shell-skeleton" aria-label={t("system.loadingApp")} aria-busy="true">
      <aside className="skeleton-panel skeleton-rail">
        <span className="skeleton-line skeleton-brand" />
        <span className="skeleton-line skeleton-control" />
        <span className="skeleton-line" />
        <span className="skeleton-line" />
        <span className="skeleton-line skeleton-short" />
      </aside>
      <section className="skeleton-panel skeleton-main">
        <header className="skeleton-header"><span className="skeleton-line skeleton-title" /></header>
        <div className="skeleton-content">
          <span className="skeleton-line" />
          <span className="skeleton-line" />
          <span className="skeleton-line skeleton-short" />
        </div>
      </section>
      <aside className="skeleton-panel skeleton-members">
        <span className="skeleton-line skeleton-title" />
        <span className="skeleton-line" />
        <span className="skeleton-line skeleton-short" />
      </aside>
      <footer className="skeleton-dock"><span className="skeleton-line skeleton-control" /></footer>
    </main>
  );
}
