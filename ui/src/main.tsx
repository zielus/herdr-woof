import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ApiError } from "@/lib/api";
import { captureToken } from "@/lib/token";
import { router } from "@/router";
import "@/index.css";
// The brand faces, self-hosted: Vite bundles the woff2 files into dist-ui/, so
// the dashboard makes no network request and renders the same offline. `wght`
// is the upright axis only — the UI sets no italics.
import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/source-code-pro/wght.css";

// Before anything fetches: moves `#token=` out of the address bar and into this
// tab, so the first request already carries it.
captureToken();

const client = new QueryClient({
  defaultOptions: {
    queries: {
      // Every read is a local file read through the engine; a stale window
      // would only make the dashboard lag behind the journal.
      staleTime: 0,
      // A wrong or missing token is answered, not a glitch: retrying it only
      // doubles the 401s behind the state the UI already shows.
      retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 1,
      refetchOnWindowFocus: true,
    },
  },
});

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
