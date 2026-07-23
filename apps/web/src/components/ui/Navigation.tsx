import type { MouseEvent,ReactNode } from "react";
export function BrandLockup({ title = "Voxly", subtitle = "The Basement", href = "/", onNavigate, onClick }: { title?: string; subtitle?: string; href?: string; onNavigate?: (path: string) => void; onClick?: () => void }) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (onNavigate) {
      linkHandler(href, onNavigate)(event);
      return;
    }
    if (onClick) {
      event.preventDefault();
      onClick();
    }
  };

  return (
    <a className="brand-lockup brand-button" href={href} onClick={handleClick}>
      <span className="brand-mark"><img src="/brand/logo-mark.svg" alt="" width="28" height="28" /></span>
      <span className="brand-copy"><strong>{title}</strong>{subtitle ? <span>{subtitle}</span> : null}</span>
    </a>
  );
}

export function NavLink({ href, className, onNavigate, onClick, children }: {
  href: string;
  className: string;
  onNavigate: (path: string) => void;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  children: ReactNode;
}) {
  const navigateOnClick = linkHandler(href, onNavigate);
  return <a className={className} href={href} onClick={(event) => {
    onClick?.(event);
    navigateOnClick(event);
  }}>{children}</a>;
}

export function linkHandler(href: string, onNavigate: (path: string) => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    onNavigate(href);
  };
}
