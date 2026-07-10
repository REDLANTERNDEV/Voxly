export interface TurnstileApi {
  render(container: HTMLElement, options: {
    sitekey: string;
    theme: "auto";
    callback: (token: string) => void;
    "error-callback": () => void;
    "expired-callback": () => void;
  }): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileScript: Promise<TurnstileApi> | null = null;

export function loadTurnstile() {
  if (window.turnstile) {
    return Promise.resolve(window.turnstile);
  }
  if (turnstileScript) {
    return turnstileScript;
  }

  turnstileScript = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile_unavailable"));
    script.onerror = () => reject(new Error("turnstile_load_failed"));
    document.head.append(script);
  }).catch((error: unknown) => {
    turnstileScript = null;
    throw error;
  });

  return turnstileScript;
}
