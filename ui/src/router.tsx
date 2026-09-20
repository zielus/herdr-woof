import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useParams,
} from "@tanstack/react-router";

import { NotificationsProvider, Shell, useNotifications } from "@/components/shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useRunNotifications } from "@/hooks/use-run-notifications";
import { RunDetail } from "@/routes/run-detail";
import { RunList } from "@/routes/run-list";

/**
 * Two routes, written by hand. The file-based routing plugin is codegen for a
 * route tree this app does not have yet; it can be adopted if the route count
 * grows.
 */

function Root() {
  // The single owner of the setting; every view below reads it from the context.
  const [notifications, setNotifications] = useNotifications();
  // Mounted on every route, because the toggle is: a run that blocks while the
  // operator is reading another run's page still has to reach them.
  useRunNotifications(notifications.enabled);
  return (
    <TooltipProvider>
      <NotificationsProvider value={notifications}>
        <Shell notifications={notifications} onNotificationsChange={setNotifications}>
          <Outlet />
        </Shell>
      </NotificationsProvider>
    </TooltipProvider>
  );
}

const rootRoute = createRootRoute({ component: Root });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: RunList,
});

const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  component: function Run() {
    const { runId } = useParams({ from: "/runs/$runId" });
    return <RunDetail runId={runId} />;
  },
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, runRoute]),
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
