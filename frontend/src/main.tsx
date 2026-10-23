import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// pages live after the "#" (/#/a/<id>): a link that lost it (/a/<id>) is sent to the right page
const lost = window.location.pathname.replace(/\/+$/, "").match(/^\/(a|r|p|compare)\/[A-Za-z0-9_/-]+$/);
if (lost && !window.location.hash) window.history.replaceState(null, "", `${import.meta.env.BASE_URL}#${lost[0]}`);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
