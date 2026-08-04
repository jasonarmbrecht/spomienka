import { useState, useEffect } from "react";
import "./styles/library-preview.css";
import { Link, Outlet, useLocation } from "react-router-dom";
import { pb } from "./pb/client";
import {
  Header,
  HeaderMenuButton,
  HeaderNavigation,
  HeaderMenuItem,
  HeaderGlobalBar,
  HeaderGlobalAction,
  SkipToContent,
  SideNav,
  SideNavItems,
  SideNavMenuItem,
  Content,
  Theme,
} from "@carbon/react";
import { Logout } from "@carbon/icons-react";
import { useAuth } from "./pb/auth";
import logo from "./assets/logo.png";

export default function App() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [isSideNavExpanded, setIsSideNavExpanded] = useState(false);
  const [activeViewers, setActiveViewers] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    const ACTIVE_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes
    const fetchViewers = async () => {
      try {
        const devices = await pb.collection("devices").getFullList<{ id: string; name: string; lastSeen?: string }>({
          fields: "id,name,lastSeen",
          requestKey: "footer-viewers",
        });
        const now = Date.now();
        setActiveViewers(
          devices.filter(
            (d) => d.lastSeen && now - new Date(d.lastSeen).getTime() < ACTIVE_THRESHOLD_MS
          )
        );
      } catch {
        // silently ignore — footer status is non-critical
      }
    };
    fetchViewers();
    const interval = setInterval(fetchViewers, 60_000);
    return () => clearInterval(interval);
  }, []);

  const navLinks = [
    { to: "/", label: "Dashboard", always: true },
    { to: "/library", label: "Library", always: true },
    { to: "/upload", label: "Upload", always: true },
    { to: "/viewer-control", label: "Viewer Control", adminOnly: true },
    { to: "/approvals", label: "Approvals", adminOnly: true },
    { to: "/users", label: "Users", adminOnly: true },
    { to: "/settings", label: "Settings", adminOnly: true },
  ].filter((l) => l.always || (l.adminOnly && user?.role === "admin"));

  return (
    <Theme
      theme="g100"
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--cds-background)",
      }}
    >
      <Header aria-label="Frame Admin">
        <SkipToContent />
        <HeaderMenuButton
          aria-label="Open menu"
          onClick={() => setIsSideNavExpanded((v) => !v)}
          isActive={isSideNavExpanded}
        />
        <Link
          to="/"
          style={{
            display: "flex",
            alignItems: "center",
            height: "100%",
            padding: "0 1rem",
            textDecoration: "none",
          }}
        >
          <img
            src={logo}
            alt="Frame Admin"
            style={{ height: "1.5rem", width: "auto", display: "block" }}
          />
        </Link>
        <HeaderNavigation aria-label="Main navigation">
          {navLinks.map((l) => (
            <HeaderMenuItem
              key={l.to}
              element={Link}
              to={l.to}
              isCurrentPage={location.pathname === l.to}
            >
              {l.label}
            </HeaderMenuItem>
          ))}
        </HeaderNavigation>
        <SideNav
          aria-label="Side navigation"
          isFixedNav
          expanded={isSideNavExpanded}
          addFocusListeners={false}
          addMouseListeners={false}
          onOverlayClick={() => setIsSideNavExpanded(false)}
        >
          <SideNavItems>
            {navLinks.map((l) => (
              <SideNavMenuItem
                key={l.to}
                element={Link}
                to={l.to}
                isActive={location.pathname === l.to}
                onClick={() => setIsSideNavExpanded(false)}
              >
                {l.label}
              </SideNavMenuItem>
            ))}
          </SideNavItems>
        </SideNav>
        <HeaderGlobalBar>
          {user && (
            <span
              style={{
                display: "flex",
                alignItems: "center",
                padding: "0 1rem",
                fontSize: "0.875rem",
                color: "var(--cds-text-secondary)",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {user.email} ({user.role})
            </span>
          )}
          <HeaderGlobalAction
            aria-label="Logout"
            tooltipAlignment="end"
            onClick={logout}
          >
            <Logout size={20} />
          </HeaderGlobalAction>
        </HeaderGlobalBar>
      </Header>
      <Content style={{ flexGrow: 1 }}>
        <Outlet />
      </Content>
      <footer
        style={{
          position: "sticky",
          bottom: 0,
          zIndex: 8000,
          background: "var(--cds-layer-01)",
          borderTop: "1px solid var(--cds-border-subtle-01)",
          padding: "0.75rem 2rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
          <span className="cds--helper-text-01" style={{ color: "var(--cds-text-secondary)", whiteSpace: "nowrap" }}>
            Viewer Status
          </span>
          {activeViewers.length === 0 ? (
            <span className="cds--helper-text-01" style={{ color: "var(--cds-text-disabled)" }}>
              No viewers online
            </span>
          ) : (
            activeViewers.map((v) => (
              <span
                key={v.id}
                className="cds--helper-text-01"
                style={{ display: "flex", alignItems: "center", gap: "0.375rem", color: "var(--cds-text-secondary)", whiteSpace: "nowrap" }}
              >
                <span style={{ color: "var(--cds-support-success)", fontSize: "0.6rem", lineHeight: 1 }}>●</span>
                {v.name}
              </span>
            ))
          )}
        </div>
        <p className="cds--helper-text-01" style={{ color: "var(--cds-text-secondary)", whiteSpace: "nowrap", flexShrink: 0 }}>
          &copy; {new Date().getFullYear()} Spomienka
        </p>
      </footer>
    </Theme>
  );
}
