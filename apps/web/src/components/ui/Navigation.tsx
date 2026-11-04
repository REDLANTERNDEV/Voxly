import type { MouseEvent, ReactNode } from "react";
export function BrandLockup({
  title = "Voxly",
  subtitle = "The Basement",
  href = "/",
  onNavigate,
  onClick
}: {
  title?: string;
  subtitle?: string;
  href?: string;
  onNavigate?: (path: string) => void;
  onClick?: () => void;
}) {
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
      <span className="brand-mark">
        <img
          className="brand-mark-image-on-light"
          src="/brand/svg/voxly-mark-monochrome-dark.svg"
          alt=""
          width="28"
          height="28"
        />
        <img
          className="brand-mark-image-on-dark"
          src="/brand/svg/voxly-mark-monochrome-light.svg"
          alt=""
          width="28"
          height="28"
        />
      </span>
      <span className="brand-copy">
        <strong>{title}</strong>
        {subtitle ? <span>{subtitle}</span> : null}
      </span>
    </a>
  );
}

export function NavLink({
  href,
  className,
  label,
  current = false,
  onNavigate,
  onClick,
  disabledReason,
  children
}: {
  href: string;
  className: string;
  /**
   * Marks a link that leads nowhere for this member, such as a Listed channel
   * they cannot enter. The link keeps its name; the reason becomes its tooltip
   * and the click does nothing.
   */
  disabledReason?: string;
  /**
   * Names the link when its own text is hidden, which is what a narrow screen
   * does to the dock's labels. Passing it also sets the tooltip, so the two
   * cannot drift apart.
   */
  label?: string;
  current?: boolean;
  onNavigate: (path: string) => void;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  children: ReactNode;
}) {
  const navigateOnClick = linkHandler(href, onNavigate);
  return (
    <a
      className={className}
      href={href}
      aria-label={label}
      aria-current={current ? "page" : undefined}
      aria-disabled={disabledReason ? true : undefined}
      title={label ?? disabledReason}
      onClick={(event) => {
        if (disabledReason) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
        navigateOnClick(event);
      }}
    >
      {children}
      {/* A tooltip alone never reaches a screen reader, so the reason is said too. */}
      {disabledReason ? <span className="sr-only">{disabledReason}</span> : null}
    </a>
  );
}

export function linkHandler(href: string, onNavigate: (path: string) => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    ) {
      return;
    }
    event.preventDefault();
    onNavigate(href);
  };
}
