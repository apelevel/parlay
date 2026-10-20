
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Admin from "./AdminDashboard";
import "./index.css";

const isAdminPage =
  new URLSearchParams(window.location.search).get("portal") === "parlay";

ReactDOM.createRoot(
  document.getElementById("root")!
).render(
  <React.StrictMode>
    {isAdminPage ? <Admin /> : <App />}
  </React.StrictMode>
);

