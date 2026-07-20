import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/manrope";
import "@fontsource-variable/newsreader";

import { App } from "./app/App";
import { ZafClientProvider } from "./app/ZafClientProvider";
import "./styles/tokens.css";
import "./styles/app.css";

const root = document.getElementById("root");
if (!root) throw new Error("Resolve root element is missing");

createRoot(root).render(
  <StrictMode>
    <ZafClientProvider>
      <App />
    </ZafClientProvider>
  </StrictMode>,
);
