import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { TerminalView } from "./TerminalView.jsx";
import "./styles.css";

// The VNC client is loaded only in the integrated viewer window, not in the tray panel.
const ScreenView = lazy(() => import("./ScreenView.jsx").then((module) => ({ default: module.ScreenView })));
const query = new URLSearchParams(location.search);

createRoot(document.getElementById("root")).render(
  query.has('terminal') ? <TerminalView/> : query.has('screen') ? <Suspense fallback={null}><ScreenView/></Suspense> : <React.StrictMode>
    <App />
  </React.StrictMode>,
);
