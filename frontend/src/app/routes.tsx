import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './providers';
import AppShell from '../components/layout/AppShell';
import LandingPage       from '../pages/LandingPage';
import LoginPage         from '../pages/LoginPage';
import DashboardPage     from '../pages/DashboardPage';
import ExamPage          from '../pages/ExamPage';
import SheetReviewPage   from '../pages/SheetReviewPage';
import SettingsPage      from '../pages/SettingsPage';
import OmrDebugPage      from '../pages/OmrDebugPage';
import ResultsPage       from '../pages/ResultsPage';
import ReviewErrorsPage  from '../pages/ReviewErrorsPage';
import AnswerKeyPage     from '../pages/AnswerKeyPage';
import TemplatePage      from '../pages/TemplatePage';
import OcrQrPage         from '../pages/OcrQrPage';
import AnalyticsPage     from '../pages/AnalyticsPage';
import ExcelPreviewPage  from '../pages/ExcelPreviewPage';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function AppRoutes() {
  return (
    <Routes>
      {/* ── Public routes ── */}
      <Route path="/"      element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />

      {/* ── Authenticated app at /app ── */}
      <Route
        path="/app"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index                  element={<DashboardPage />} />
        <Route path="exams"           element={<ExamPage />} />
        <Route path="upload"          element={<SheetReviewPage />} />
        <Route path="results"         element={<ResultsPage />} />
        <Route path="review-errors"   element={<ReviewErrorsPage />} />
        <Route path="answer-key"      element={<AnswerKeyPage />} />
        <Route path="templates"       element={<TemplatePage />} />
        <Route path="ocr-qr"          element={<OcrQrPage />} />
        <Route path="analytics"       element={<AnalyticsPage />} />
        <Route path="excel-preview"   element={<ExcelPreviewPage />} />
        <Route path="settings"        element={<SettingsPage />} />
        <Route path="review"          element={<Navigate to="/app/upload" replace />} />
        <Route path="*"               element={<Navigate to="/app" replace />} />
      </Route>

      {/* ── Dev-only ── */}
      <Route path="/omr-debug" element={<AppShell />}>
        <Route index element={<OmrDebugPage />} />
      </Route>

      {/* Catch-all → Landing */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
