import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyThemeChoice, readThemeChoice } from "./app/navigation.js";
import { App } from "./App.js";
import { BrowserCompatibilityGate } from "./components/BrowserCompatibilityGate.js";
import "./styles.css";
import "./visual-refresh.css";

applyThemeChoice(readThemeChoice());

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <BrowserCompatibilityGate userAgent={navigator.userAgent}>
      <App />
    </BrowserCompatibilityGate>
  </StrictMode>
);
