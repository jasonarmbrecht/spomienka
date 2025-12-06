import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import "./index.css";
import App from "./App";
import { LoginPage } from "./pages/LoginPage";
import { UploadPage } from "./pages/UploadPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { LibraryPage } from "./pages/LibraryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { UsersPage } from "./pages/UsersPage";
import { AuthProvider, RequireAuth, RequireAdmin } from "./pb/auth";

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { path: "/", element: <RequireAuth redirect="/login"><UploadPage /></RequireAuth> },
      { path: "/upload", element: <RequireAuth redirect="/login"><UploadPage /></RequireAuth> },
      { path: "/approvals", element: <RequireAdmin redirect="/login"><ApprovalsPage /></RequireAdmin> },
      { path: "/library", element: <RequireAuth redirect="/login"><LibraryPage /></RequireAuth> },
      { path: "/settings", element: <RequireAdmin redirect="/login"><SettingsPage /></RequireAdmin> },
      { path: "/users", element: <RequireAdmin redirect="/login"><UsersPage /></RequireAdmin> }
    ]
  },
  { path: "/login", element: <LoginPage /> }
]);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </React.StrictMode>
);

