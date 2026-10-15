import { Spin } from "antd";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppProviders } from "./app";

const AppLayout = lazy(() => import("./layouts/AppLayout"));
const ActionsPage = lazy(() => import("./pages/actions"));
const AuditPage = lazy(() => import("./pages/audit"));
const LoginPage = lazy(() => import("./pages/login"));
const MembersPage = lazy(() => import("./pages/members"));
const NotFoundPage = lazy(() => import("./pages/not-found"));
const OverviewPage = lazy(() => import("./pages/overview"));
const PatsPage = lazy(() => import("./pages/pats"));
const RolesPage = lazy(() => import("./pages/roles"));
const SetupPage = lazy(() => import("./pages/setup"));
const TasksPage = lazy(() => import("./pages/tasks"));
const UsersPage = lazy(() => import("./pages/users"));
const WecomPage = lazy(() => import("./pages/wecom"));

function RouteFallback() {
  return (
    <div className="route-fallback" role="status" aria-label="页面加载中">
      <Spin size="large" />
    </div>
  );
}

function AppRoutes() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<AppLayout />}>
          <Route index element={<Navigate to="/overview" replace />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="actions" element={<ActionsPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="roles" element={<RolesPage />} />
          <Route path="pats" element={<PatsPage />} />
          <Route path="wecom" element={<WecomPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("缺少 #root 挂载节点");
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <AppProviders>
        <AppRoutes />
      </AppProviders>
    </BrowserRouter>
  </StrictMode>,
);
