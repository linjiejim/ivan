import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  isRouteErrorResponse,
  Link,
  RouterProvider,
  useRouteError,
} from "react-router";
import { ChatProvider } from "./chat/chat-context.tsx";
import { Layout } from "./components/layout.tsx";
import { AdminPage } from "./pages/admin.tsx";
import { LoginPage, RegisterPage } from "./pages/auth.tsx";
import { ChatPage } from "./pages/chat.tsx";
import { DashboardPage } from "./pages/dashboard.tsx";
import { RunPage } from "./pages/run.tsx";
import { SignalsPage } from "./pages/signals.tsx";
import { StrategiesPage } from "./pages/strategies.tsx";
import { StrategyPage } from "./pages/strategy.tsx";
import { TrackingPage } from "./pages/tracking.tsx";

// 手动选过主题的，启动时就套上，避免闪一下
const savedTheme = localStorage.getItem("ivan.theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function NotFound({ error }: { error?: unknown }) {
  const missing = !error || (isRouteErrorResponse(error) && error.status === 404);
  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <p className="text-sm font-medium">{missing ? "没有这个页面" : "页面出错了"}</p>
      {!missing && (
        <p className="mt-1 text-xs text-muted">
          {error instanceof Error ? error.message : "刷新一下试试"}
        </p>
      )}
      <Link to="/" className="mt-4 inline-block text-sm text-accent">
        回到看板
      </Link>
    </div>
  );
}

function RouteError() {
  return <NotFound error={useRouteError()} />;
}

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/register", element: <RegisterPage /> },
  {
    path: "/",
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "strategies", element: <StrategiesPage /> },
      { path: "strategies/:id", element: <StrategyPage /> },
      { path: "runs/:id", element: <RunPage /> },
      { path: "trackings/:id", element: <TrackingPage /> },
      { path: "signals", element: <SignalsPage /> },
      { path: "admin", element: <AdminPage /> },
      { path: "chat", element: <ChatPage /> },
      { path: "chat/:threadId", element: <ChatPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ChatProvider>
        <RouterProvider router={router} />
      </ChatProvider>
    </QueryClientProvider>
  </StrictMode>,
);
