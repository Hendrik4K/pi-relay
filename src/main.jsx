import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles.css";
import "./i18n.js";

// The VNC client and the terminal are loaded only in their own windows, not in the tray panel.
const ScreenView = lazy(() => import("./ScreenView.jsx").then((module) => ({ default: module.ScreenView })));
const TerminalView = lazy(() => import("./TerminalView.jsx").then((module) => ({ default: module.TerminalView })));
const query = new URLSearchParams(location.search);

// A rendering error shows a way back instead of an empty window.
class Recover extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div style={{ padding: 24, color: "#f1edf3", font: "14px 'Segoe UI', sans-serif" }}>
      Die Ansicht ist auf einen Fehler gestoßen. <button onClick={() => location.reload()}>Neu laden</button>
    </div>;
  }
}

createRoot(document.getElementById("root")).render(
  <Recover>{query.has('terminal') ? <Suspense fallback={null}><TerminalView/></Suspense> : query.has('screen') ? <Suspense fallback={null}><ScreenView/></Suspense> : <React.StrictMode>
    <App />
  </React.StrictMode>}</Recover>,
);
