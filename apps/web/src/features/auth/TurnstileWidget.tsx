import { useEffect, useRef } from "react";
import { loadTurnstile } from "../../lib/turnstile.js";

/**
 * The operator's optional human check. Callbacks are read through refs so a
 * parent rerender — which every screen using this does when a token arrives —
 * never removes the iframe that just produced the token.
 */
export function TurnstileWidget({
  siteKey,
  resetKey,
  onToken,
  onUnavailable
}: {
  siteKey: string;
  resetKey: number;
  onToken: (token: string) => void;
  onUnavailable: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onTokenRef = useRef(onToken);
  const onUnavailableRef = useRef(onUnavailable);
  onTokenRef.current = onToken;
  onUnavailableRef.current = onUnavailable;

  useEffect(() => {
    let isActive = true;
    let widgetId: string | null = null;
    onTokenRef.current("");

    loadTurnstile()
      .then((turnstile) => {
        if (!isActive || !containerRef.current) return;
        widgetId = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme: "auto",
          callback: (token) => {
            if (isActive) onTokenRef.current(token);
          },
          "expired-callback": () => {
            if (isActive) onTokenRef.current("");
          },
          "error-callback": () => {
            if (isActive) onUnavailableRef.current();
          }
        });
      })
      .catch(() => {
        if (isActive) onUnavailableRef.current();
      });

    return () => {
      isActive = false;
      if (widgetId && window.turnstile) {
        window.turnstile.remove(widgetId);
      }
    };
  }, [resetKey, siteKey]);

  return <div className="turnstile-widget" ref={containerRef} />;
}
