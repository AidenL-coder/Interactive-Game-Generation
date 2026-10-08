import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import Game3D from "./Game3D.jsx";
import "./styles.css";
import "./styles2d.css";

// Two renderers, one app. The 2D illustrated stage is the default; `?engine=3d` opens the
// first-person world instead. A query parameter rather than a route because the dev
// server, a static host and a file:// preview all serve it identically.
const engine = new URLSearchParams(window.location.search).get("engine");
const Root = engine === "3d" ? Game3D : App;

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
