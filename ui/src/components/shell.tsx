import { Link } from "@tanstack/react-router";
import { BellIcon, BellOffIcon, MoonIcon, SunIcon } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { Switch } from "@/components/ui/switch";
import mark from "../../../assets/brand/woof.svg";
import {
  notificationsPermission,
  notificationsSupported,
  requestNotificationPermission,
  STORAGE_KEY,
} from "@/lib/notifications";

const THEME_KEY = "woof.theme";

function storedTheme(): "dark" | "light" {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Dark first, light required. index.html has already applied the stored value. */
function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">(storedTheme);

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Private browsing: the choice just does not persist.
    }
  }, [theme]);

  return (
    <button
      type="button"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring inline-flex size-8 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none"
      aria-label={theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}
    >
      {theme === "dark" ? <MoonIcon className="size-4" /> : <SunIcon className="size-4" />}
    </button>
  );
}

export interface NotificationsState {
  enabled: boolean;
  permission: NotificationPermission | "unsupported";
}

/**
 * Notifications are off until the operator turns them on, and permission is
 * requested from that click — never on load. A denied permission is reported
 * as denied; the switch never pretends to be on.
 */
function NotificationsToggle({
  state,
  onChange,
}: {
  state: NotificationsState;
  onChange: (next: NotificationsState) => void;
}) {
  const unsupported = state.permission === "unsupported";
  const denied = state.permission === "denied";
  const title = unsupported
    ? "this browser has no Notification API"
    : denied
      ? "notifications are blocked for this origin in the browser's settings"
      : "notify when a run becomes blocked, failed, exhausted or completed";

  return (
    <label className="flex items-center gap-2 text-xs" title={title}>
      {state.enabled && !denied && !unsupported ? (
        <BellIcon className="text-muted-foreground size-4" />
      ) : (
        <BellOffIcon className="text-muted-foreground size-4" />
      )}
      <span className="text-muted-foreground hidden sm:inline">notify</span>
      <Switch
        size="sm"
        disabled={unsupported || denied}
        checked={state.enabled && !denied && !unsupported}
        onCheckedChange={(checked: boolean) => {
          if (!checked) {
            onChange({ ...state, enabled: false });
            return;
          }
          void requestNotificationPermission().then((permission) => {
            onChange({ enabled: permission === "granted", permission });
          });
        }}
      />
    </label>
  );
}

/**
 * The current setting, for any view that reacts to it.
 *
 * `useNotifications` owns the state and must be called exactly once, by the
 * shell. A second call would create a second, independent `useState`, and the
 * view reading it would never see the toggle move — so readers take the value
 * from this context instead.
 */
const NotificationsContext = createContext<NotificationsState>({
  enabled: false,
  permission: "default",
});

export const NotificationsProvider = NotificationsContext.Provider;

export function useNotificationsValue(): NotificationsState {
  return useContext(NotificationsContext);
}

export function useNotifications(): [NotificationsState, (next: NotificationsState) => void] {
  const [state, setState] = useState<NotificationsState>(() => {
    let wanted = false;
    try {
      wanted = localStorage.getItem(STORAGE_KEY) === "on";
    } catch {
      wanted = false;
    }
    const permission = notificationsPermission();
    return { enabled: wanted && permission === "granted", permission };
  });

  const update = (next: NotificationsState) => {
    setState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next.enabled ? "on" : "off");
    } catch {
      // Not persisting the preference is not worth failing over.
    }
  };
  return [state, update];
}

export function Shell({
  children,
  notifications,
  onNotificationsChange,
}: {
  children: ReactNode;
  notifications: NotificationsState;
  onNotificationsChange: (next: NotificationsState) => void;
}) {
  return (
    <div className="min-h-dvh">
      <header className="bg-surface/90 border-border sticky top-0 z-40 flex h-11 items-center gap-3 border-b px-3 backdrop-blur supports-backdrop-filter:bg-surface/70 sm:px-4">
        <Link to="/" className="flex items-center gap-2 font-medium">
          <img src={mark} alt="" className="size-5" />
          <span className="tracking-tight">woof</span>
        </Link>
        <span className="text-faint hidden font-mono text-xs sm:inline">runs</span>
        <div className="ml-auto flex items-center gap-3">
          {notificationsSupported() || notifications.permission === "unsupported" ? (
            <NotificationsToggle state={notifications} onChange={onNotificationsChange} />
          ) : null}
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1120px] px-3 py-4 sm:px-4 sm:py-6">{children}</main>
    </div>
  );
}
