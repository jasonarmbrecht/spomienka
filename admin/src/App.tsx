import { Link, Outlet } from "react-router-dom";
import { useAuth } from "./pb/auth";

export default function App() {
  const { user, logout } = useAuth();

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Frame Admin</div>
        <nav>
          <Link to="/upload">Upload</Link>
          {user?.role === "admin" && (
            <>
              <Link to="/approvals">Approvals</Link>
              <Link to="/settings">Settings</Link>
              <Link to="/users">Users</Link>
            </>
          )}
          <Link to="/library">Library</Link>
        </nav>
        <div className="user">
          {user ? (
            <>
              <span>{user.email} ({user.role})</span>
              <button onClick={logout}>Logout</button>
            </>
          ) : (
            <Link to="/login">Login</Link>
          )}
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

