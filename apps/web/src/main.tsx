import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { BrowserCompatibilityGate } from "./components/BrowserCompatibilityGate.js";
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <BrowserCompatibilityGate userAgent={navigator.userAgent}>
      <App />
    </BrowserCompatibilityGate>
  </StrictMode>
);
