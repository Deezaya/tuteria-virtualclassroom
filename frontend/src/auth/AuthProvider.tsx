import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ApiError, getCurrentUser, login as loginRequest, logout as logoutRequest, type User } from "../api/client";

type AuthStatus = "loading" | "ready" | "error";

type AuthContextValue = {
  user: User | null;
  status: AuthStatus;
  error: string | null;
  retry: () => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setStatus("loading");
    setError(null);

    getCurrentUser()
      .then(({ user: currentUser }) => {
        if (active) {
          setUser(currentUser);
          setStatus("ready");
        }
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof ApiError && cause.status === 401) {
          setUser(null);
          setStatus("ready");
          return;
        }
        setError(cause instanceof Error ? cause.message : "Unable to verify your sign-in.");
        setStatus("error");
      });

    return () => {
      active = false;
    };
  }, [loadAttempt]);

  const retry = useCallback(() => setLoadAttempt((attempt) => attempt + 1), []);

  const login = useCallback(async (email: string, password: string) => {
    const response = await loginRequest(email, password);
    setUser(response.user);
    setStatus("ready");
    setError(null);
  }, []);

  const logout = useCallback(async () => {
    await logoutRequest();
    setUser(null);
    setStatus("ready");
    setError(null);
  }, []);

  const value = useMemo(
    () => ({ user, status, error, retry, login, logout }),
    [user, status, error, retry, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider.");
  }
  return context;
}
