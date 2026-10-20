
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Admin from "./AdminDashboard";
import "./index.css";

const isAdminPage =
  window.location.pathname === "/admin" ||
  window.location.pathname === "/admin/";

ReactDOM.createRoot(
  document.getElementById("root")!
).render(
  <React.StrictMode>
    {isAdminPage ? <Admin /> : <App />}
  </React.StrictMode>
);
