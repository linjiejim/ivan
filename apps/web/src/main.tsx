import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import { IconContext } from "@phosphor-icons/react";
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
import { IconArrowRight } from "./components/icons.tsx";
import { Layout } from "./components/layout.tsx";
import { InkArt } from "./components/ui.tsx";
import { applyTheme, readThemePref } from "./lib/theme.ts";

// 手动选过主题的，启动时就套上，避免闪一下
applyTheme(readThemePref());

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function NotFound({ error }: { error?: unknown }) {
  const missing = !error || (isRouteErrorResponse(error) && error.status === 404);
  return (
    <div className="mx-auto flex min-h-[60dvh] max-w-md animate-enter flex-col items-center justify-center px-4 py-16 text-center">
      <InkArt name="lost" className="mb-4 size-44 object-contain" />
      <h1 className="text-lg font-semibold text-ink">{missing ? "没有这个页面" : "页面出错了"}</h1>
      <p className="mt-1.5 text-sm text-muted">
        {missing
          ? "链接可能过期了，或者这个页面已经被删掉。"
          : error instanceof Error
            ? error.message
            : "刷新一下试试。"}
      </p>
      <Link
        to="/"
        className="mt-6 inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-ink shadow-raise transition-colors hover:bg-primary-hover"
      >
        回到看板
        <IconArrowRight size={15} />
      </Link>
    </div>
  );
}

function RouteError() {
  return <NotFound error={useRouteError()} />;
}

// 每个页面单独一个包：外框和基础组件在入口里，ECharts 跟着第一个用到图表的页面按需加载（登录页用不到）
const page =
  <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  async () => ({ Component: (await load())[name] });

/** 首次加载页面包时的占位：和纸色一致，不闪白 */
function Boot() {
  return <div className="min-h-dvh bg-page" aria-busy="true" />;
}

const router = createBrowserRouter([
  {
    path: "/login",
    lazy: page(() => import("./pages/auth.tsx"), "LoginPage"),
    hydrateFallbackElement: <Boot />,
  },
  {
    path: "/register",
    lazy: page(() => import("./pages/auth.tsx"), "RegisterPage"),
    hydrateFallbackElement: <Boot />,
  },
  {
    path: "/apply",
    lazy: page(() => import("./pages/auth.tsx"), "ApplyPage"),
    hydrateFallbackElement: <Boot />,
  },
  {
    path: "/",
    element: <Layout />,
    errorElement: <RouteError />,
    hydrateFallbackElement: <Boot />,
    children: [
      { index: true, lazy: page(() => import("./pages/dashboard.tsx"), "DashboardPage") },
      { path: "strategies", lazy: page(() => import("./pages/strategies.tsx"), "StrategiesPage") },
      { path: "strategies/:id", lazy: page(() => import("./pages/strategy.tsx"), "StrategyPage") },
      { path: "runs/:id", lazy: page(() => import("./pages/run.tsx"), "RunPage") },
      { path: "trackings/:id", lazy: page(() => import("./pages/tracking.tsx"), "TrackingPage") },
      { path: "signals", lazy: page(() => import("./pages/signals.tsx"), "SignalsPage") },
      { path: "admin", lazy: page(() => import("./pages/admin.tsx"), "AdminPage") },
      { path: "chat", lazy: page(() => import("./pages/chat.tsx"), "ChatPage") },
      { path: "chat/:threadId", lazy: page(() => import("./pages/chat.tsx"), "ChatPage") },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <IconContext.Provider value={{ size: 16, weight: "regular" }}>
      <QueryClientProvider client={queryClient}>
        <ChatProvider>
          <RouterProvider router={router} />
        </ChatProvider>
      </QueryClientProvider>
    </IconContext.Provider>
  </StrictMode>,
);
