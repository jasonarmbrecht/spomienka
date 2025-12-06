import { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { pb } from "./client";

type User = { id: string; email: string; role?: string };
type AuthContextType = {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    if (pb.authStore.isValid) {
      setUser(pb.authStore.model as User);
    }
    const unsubscribe = pb.authStore.onChange((token, model) => {
      if (token && model) {
        setUser(model as User);
      } else {
        setUser(null);
      }
    });
    return () => unsubscribe();
  }, []);

  const login = async (email: string, password: string) => {
    await pb.collection("users").authWithPassword(email, password);
  };

  const logout = () => {
    pb.authStore.clear();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function RequireAuth({ children, redirect }: { children: ReactNode; redirect: string }) {
  const { user } = useAuth();
  if (!user) return <Navigate to={redirect} replace />;
  return <>{children}</>;
}

export function RequireAdmin({ children, redirect }: { children: ReactNode; redirect: string }) {
  const { user } = useAuth();
  if (!user || user.role !== "admin") return <Navigate to={redirect} replace />;
  return <>{children}</>;
}

