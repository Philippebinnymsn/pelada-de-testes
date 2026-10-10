import React from "react";
import { createRoot } from "react-dom/client";
import PeladaApp from "./App.jsx";

const container = document.getElementById("root");
const root = createRoot(container);
root.render(
  <React.StrictMode>
    <PeladaApp />
  </React.StrictMode>
);

// Registra o service worker (funciona offline / cache dos assets) se suportado
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline opcional — se falhar, o app continua funcionando online normalmente */
    });
  });
}
