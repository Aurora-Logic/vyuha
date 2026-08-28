import { lazy, Suspense } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router';

import { AppShell } from '@/app/layout/app-shell';
import { AdminShell } from '@/features/administration/admin-shell';
import { SessionGate } from '@/app/session-gate';
import { ShortcutProvider } from '@/lib/keyboard/registry';
import { ALL_NAV_ITEMS } from '@/lib/nav';

/**
 * Routes with a screen of their own. Everything else in the navigation falls
 * through to the placeholder, so the two lists cannot both claim a path — the
 * filter below is driven by this set rather than by a second hand-written list
 * that would go stale the next time a screen ships.
 */
const BUILT_ROUTES = new Set([
  '/sales/estimates',
  '/sales/orders',
  '/sales/invoices',
  '/sales/pick-queue',
  '/sales/awaiting-invoice',
  '/sales/dispatches',
  '/purchase/requirements',
  '/purchase/orders',
  '/purchase/grns',
  '/tasks',
  '/crm/deals',
  '/crm/contacts',
  '/crm/companies',
  '/masters/parties',
  '/masters/items',
  '/masters/price-lists',
  '/masters/vouchers',
  '/dashboard',
  '/employees',
  '/punch',
  '/my-attendance',
  '/team-attendance',
  '/shifts',
  '/my-leave',
  '/approvals',
  '/leave-types',
  '/holidays',
  '/settings',
  '/roles',
  '/integrations',
  '/audit',
  '/period-lock',
  '/downloads',
  '/reports',
  '/reports/attendance',
  '/reports/receivables',
  '/reports/sales',
  '/reports/sync',
  '/reports/growth',
  '/reports/team',
  '/reports/sales-analysis',
  '/reports/margin',
  '/reports/brands',
  '/reports/analytics',
  '/reports/export-centre',
  '/reports/close-pack',
  '/reports/desk',
  '/reports/data-quality',
  '/reports/penetration',
  '/reports/class-grade',
  '/reports/definitions',
  '/reports/exceptions',
  '/reports/alerts',
  '/reports/me',
  '/reports/credit',
  '/reports/work-lists',
  '/reports/custom',
  '/recycle-bin',
  '/organisation',
  '/analytics',
  '/regularizations',
  '/team-leave',
]);


// P-23: every page is its own chunk, loaded on navigation. The shell
// ships in the entry bundle; a route's code arrives when the route does.
const EmployeeDetailPage = lazy(() => import('@/features/employees').then((m) => ({ default: m.EmployeeDetailPage })));
const EmployeesPage = lazy(() => import('@/features/employees').then((m) => ({ default: m.EmployeesPage })));
const ApprovalsPage = lazy(() => import('@/features/approvals').then((m) => ({ default: m.ApprovalsPage })));
const MyAttendancePage = lazy(() => import('@/features/attendance').then((m) => ({ default: m.MyAttendancePage })));
const TeamAttendancePage = lazy(() => import('@/features/attendance').then((m) => ({ default: m.TeamAttendancePage })));
const HolidaysPage = lazy(() => import('@/features/holidays').then((m) => ({ default: m.HolidaysPage })));
const LeaveTypesPage = lazy(() => import('@/features/leave').then((m) => ({ default: m.LeaveTypesPage })));
const MyLeavePage = lazy(() => import('@/features/leave').then((m) => ({ default: m.MyLeavePage })));
const TeamLeavePage = lazy(() => import('@/features/leave').then((m) => ({ default: m.TeamLeavePage })));
const PatternsPage = lazy(() => import('@/features/patterns/patterns-page').then((m) => ({ default: m.PatternsPage })));
const PunchPage = lazy(() => import('@/features/punch').then((m) => ({ default: m.PunchPage })));
const RegularizationsPage = lazy(() => import('@/features/regularization').then((m) => ({ default: m.RegularizationsPage })));
const ShiftsPage = lazy(() => import('@/features/shifts').then((m) => ({ default: m.ShiftsPage })));
const AnalyticsPage = lazy(() => import('@/features/analytics').then((m) => ({ default: m.AnalyticsPage })));
const AuditLogPage = lazy(() => import('@/features/audit').then((m) => ({ default: m.AuditLogPage })));
const DownloadsPage = lazy(() => import('@/features/downloads').then((m) => ({ default: m.DownloadsPage })));
const InsightsOverviewPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.InsightsOverviewPage })));
const InsightsAreaPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.AreaPage })));
const CustomReportsPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.CustomReportsPage })));
const CustomReportPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.CustomReportPage })));
const CreditControlPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.CreditControlPage })));
const WorkListsPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.WorkListsPage })));
const MyCfoPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.MyCfoPage })));
const GrowthPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.GrowthPage })));
const TeamPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.TeamPage })));
const SalesAnalysisPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.SalesAnalysisPage })));
const DeskPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.DeskPage })));
const DataQualityPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.DataQualityPage })));
const PenetrationPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.PenetrationPage })));
const ClassGradePage = lazy(() => import('@/features/insights').then((m) => ({ default: m.ClassGradePage })));
const DefinitionsPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.DefinitionsPage })));
const ExceptionsPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.ExceptionsPage })));
const AlertsPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.AlertsPage })));
const MarginPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.MarginPage })));
const BrandsPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.BrandsPage })));
const CfoAnalyticsPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.AnalyticsPage })));
const ExportCentrePage = lazy(() => import('@/features/insights').then((m) => ({ default: m.ExportCentrePage })));
const ClosePackPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.ClosePackPage })));
const ClosePackPrintPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.ClosePackPrintPage })));
const ScorecardPage = lazy(() => import('@/features/insights').then((m) => ({ default: m.ScorecardPage })));
const IntegrationsPage = lazy(() => import('@/features/integrations').then((m) => ({ default: m.IntegrationsPage })));
const PeriodLockPage = lazy(() => import('@/features/period-lock').then((m) => ({ default: m.PeriodLockPage })));
const RecycleBinPage = lazy(() => import('@/features/recycle-bin').then((m) => ({ default: m.RecycleBinPage })));
const DashboardPage = lazy(() => import('@/features/dashboard/dashboard-page').then((m) => ({ default: m.DashboardPage })));
const LandingPage = lazy(() => import('@/features/dashboard/landing').then((m) => ({ default: m.LandingPage })));
const InterestOverridesPage = lazy(() => import('@/features/interest/overrides-page').then((m) => ({ default: m.InterestOverridesPage })));
const AdministrationScreen = lazy(() => import('@/features/administration/administration-screen').then((m) => ({ default: m.AdministrationScreen })));
const RolesPage = lazy(() => import('@/features/roles').then((m) => ({ default: m.RolesPage })));
const SettingsPage = lazy(() => import('@/features/settings').then((m) => ({ default: m.SettingsPage })));
const NotificationsPage = lazy(() => import('@/features/notifications').then((m) => ({ default: m.NotificationsPage })));
const CompaniesPage = lazy(() => import('@/features/crm/companies-page').then((m) => ({ default: m.CompaniesPage })));
const ContactsPage = lazy(() => import('@/features/crm/contacts-page').then((m) => ({ default: m.ContactsPage })));
const DealsPage = lazy(() => import('@/features/crm/deals-page').then((m) => ({ default: m.DealsPage })));
const EstimatesPage = lazy(() => import('@/features/sales/estimates-page').then((m) => ({ default: m.EstimatesPage })));
const EstimateEditorPage = lazy(() => import('@/features/sales/estimate-editor-page').then((m) => ({ default: m.EstimateEditorPage })));
const DocumentPrintPage = lazy(() => import('@/features/documents/print-page').then((m) => ({ default: m.DocumentPrintPage })));
const SalesOrdersPage = lazy(() => import('@/features/sales/sales-orders-page').then((m) => ({ default: m.SalesOrdersPage })));
const DispatchPaperPage = lazy(() => import('@/features/sales/dispatch-paper-page').then((m) => ({ default: m.DispatchPaperPage })));
const PackingSlipPage = lazy(() => import('@/features/sales/packing-slip-page').then((m) => ({ default: m.PackingSlipPage })));
const SalesOrderEditorPage = lazy(() => import('@/features/sales/sales-order-editor-page').then((m) => ({ default: m.SalesOrderEditorPage })));
const InvoicesPage = lazy(() => import('@/features/sales/invoices-page').then((m) => ({ default: m.InvoicesPage })));
const InvoiceEditorPage = lazy(() => import('@/features/sales/invoice-editor-page').then((m) => ({ default: m.InvoiceEditorPage })));
const PickQueuePage = lazy(() => import('@/features/sales/pick-queue-page').then((m) => ({ default: m.PickQueuePage })));
const AwaitingInvoicePage = lazy(() => import('@/features/sales/awaiting-invoice-page').then((m) => ({ default: m.AwaitingInvoicePage })));
const DispatchesPage = lazy(() => import('@/features/sales/dispatches-page').then((m) => ({ default: m.DispatchesPage })));
const ScanPage = lazy(() => import('@/features/sales/scan-page').then((m) => ({ default: m.ScanPage })));
const PackedPage = lazy(() => import('@/features/sales/packed-page').then((m) => ({ default: m.PackedPage })));
const RequirementsPage = lazy(() => import('@/features/purchase/requirements-page').then((m) => ({ default: m.RequirementsPage })));
const GrnPaperPage = lazy(() => import('@/features/purchase/grn-paper-page').then((m) => ({ default: m.GrnPaperPage })));
const PurchaseOrderEditorPage = lazy(() => import('@/features/purchase/purchase-order-editor-page').then((m) => ({ default: m.PurchaseOrderEditorPage })));
const PurchaseOrdersPage = lazy(() => import('@/features/purchase/purchase-orders-page').then((m) => ({ default: m.PurchaseOrdersPage })));
const GrnsPage = lazy(() => import('@/features/purchase/grns-page').then((m) => ({ default: m.GrnsPage })));
const PartiesPage = lazy(() => import('@/features/masters/parties-page').then((m) => ({ default: m.PartiesPage })));
const TasksPage = lazy(() => import('@/features/tasks/tasks-page').then((m) => ({ default: m.TasksPage })));
const PriceListPage = lazy(() => import('@/features/pricing/price-list-page').then((m) => ({ default: m.PriceListPage })));
const PriceListsPage = lazy(() => import('@/features/pricing/price-lists-page').then((m) => ({ default: m.PriceListsPage })));
const StockItemsPage = lazy(() => import('@/features/masters/stock-items-page').then((m) => ({ default: m.StockItemsPage })));
const StockItemPage = lazy(() => import('@/features/masters/item-page').then((m) => ({ default: m.StockItemPage })));
const PartyPage = lazy(() => import('@/features/masters/party-page').then((m) => ({ default: m.PartyPage })));
const ReturnsPage = lazy(() => import('@/features/returns/returns-page').then((m) => ({ default: m.ReturnsPage })));
const PortalLinksPage = lazy(() => import('@/features/portal/portal-links-page').then((m) => ({ default: m.PortalLinksPage })));
const CollectionsPage = lazy(() => import('@/features/collections/collections-page').then((m) => ({ default: m.CollectionsPage })));
const DuplicatesPage = lazy(() => import('@/features/masters/duplicates-page').then((m) => ({ default: m.DuplicatesPage })));
const VouchersPage = lazy(() => import('@/features/masters/vouchers-page').then((m) => ({ default: m.VouchersPage })));
const VoucherPaperPage = lazy(() => import('@/features/masters/voucher-paper-page').then((m) => ({ default: m.VoucherPaperPage })));
const PlaceholderPage = lazy(() => import('@/features/placeholder/placeholder-page').then((m) => ({ default: m.PlaceholderPage })));
const OrgMastersPage = lazy(() => import('@/features/org-masters').then((m) => ({ default: m.OrgMastersPage })));
const ProfilePage = lazy(() => import('@/features/profile/profile-page').then((m) => ({ default: m.ProfilePage })));
const UpdatesPage = lazy(() => import('@/features/updates').then((m) => ({ default: m.UpdatesPage })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // An operations tool is read constantly; refetching a muster on every
      // window focus would be a lot of noise for little freshness.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: 1,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionGate>
        <ShortcutProvider>
          <Suspense fallback={null}>
          <Routes>
            {/* The paper and nothing else: printed from its own tab, outside the shell (REQ-W-01, print and PDF). */}
            <Route path="print/close-pack" element={<ClosePackPrintPage />} />
            <Route path="print/:kind/:id" element={<DocumentPrintPage />} />

            <Route element={<AppShell />}>
              <Route index element={<LandingPage />} />

              {/*
                Administration is one area with one shell (owner, 27 Aug 2026): a
                Supabase-shaped rail of settings pages and workspace screens beside
                the content column. A layout route rather than a wrapper in each
                screen, so a screen cannot forget it and the rail does not remount
                when one screen is left for another.
              */}
              <Route element={<AdminShell />}>
                <Route path="administration" element={<AdministrationScreen />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="organisation" element={<OrgMastersPage />} />
                <Route path="shifts" element={<ShiftsPage />} />
                <Route path="leave-types" element={<LeaveTypesPage />} />
                <Route path="holidays" element={<HolidaysPage />} />
                <Route path="period-lock" element={<PeriodLockPage />} />
                <Route path="roles" element={<RolesPage />} />
                <Route path="integrations" element={<IntegrationsPage />} />
                <Route path="audit" element={<AuditLogPage />} />
                <Route path="recycle-bin" element={<RecycleBinPage />} />
                <Route path="downloads" element={<DownloadsPage />} />
                {/* D-22's per-party overrides: reached from the Interest cost
                    section of Settings, not from the sidebar. The address lost
                    its /reports prefix when that module was removed (owner,
                    26 Aug 2026). */}
                <Route path="interest-overrides" element={<InterestOverridesPage />} />
              </Route>
              {/*
                The attendance dashboard has its own address now. It used to
                be "/", which was fine while "/" meant one thing -- then "/"
                started choosing where to send people, and the two meanings
                collided: clicking Attendance navigated to "/", which
                immediately redirected away again, so the module could not be
                opened at all by anyone the redirect applied to.
              */}
              <Route path="dashboard" element={<DashboardPage />} />

              <Route path="employees" element={<EmployeesPage />} />
              <Route path="employees/:id" element={<EmployeeDetailPage />} />

              <Route path="punch" element={<PunchPage />} />
              <Route path="my-leave" element={<MyLeavePage />} />
              <Route path="approvals" element={<ApprovalsPage />} />
              <Route path="my-attendance" element={<MyAttendancePage />} />
              <Route path="team-attendance" element={<TeamAttendancePage />} />

              <Route path="masters/parties" element={<PartiesPage />} />
              <Route path="masters/parties/:id" element={<PartyPage />} />
              <Route path="masters/items" element={<StockItemsPage />} />
              <Route path="masters/items/:id" element={<StockItemPage />} />
              <Route path="masters/price-lists" element={<PriceListsPage />} />
              <Route path="masters/price-lists/new" element={<PriceListPage />} />
              <Route path="masters/price-lists/:id" element={<PriceListPage />} />
              <Route path="sales/returns" element={<ReturnsPage />} />
              <Route path="collections" element={<CollectionsPage />} />
              <Route path="masters/portal-links" element={<PortalLinksPage />} />
              <Route path="masters/duplicates" element={<DuplicatesPage />} />
              <Route path="masters/vouchers" element={<VouchersPage />} />
              <Route path="masters/vouchers/:id" element={<VouchersPage />} />
              <Route path="masters/vouchers/:id/paper" element={<VoucherPaperPage />} />
              <Route path="crm/contacts" element={<ContactsPage />} />
              <Route path="crm/contacts/:id" element={<ContactsPage />} />
              <Route path="crm/companies" element={<CompaniesPage />} />
              <Route path="crm/companies/:id" element={<CompaniesPage />} />
              <Route path="tasks" element={<TasksPage />} />
              <Route path="tasks/:id" element={<TasksPage />} />
              <Route path="crm/deals" element={<DealsPage />} />
              <Route path="crm/deals/:id" element={<DealsPage />} />
              <Route path="sales/estimates" element={<EstimatesPage />} />
              <Route path="sales/estimates/new" element={<EstimateEditorPage />} />
              <Route path="sales/estimates/:id" element={<EstimateEditorPage />} />
              <Route path="sales/orders" element={<SalesOrdersPage />} />
              <Route path="sales/orders/new" element={<SalesOrderEditorPage />} />
              <Route path="sales/orders/:id" element={<SalesOrderEditorPage />} />
              <Route path="sales/invoices" element={<InvoicesPage />} />
              <Route path="sales/invoices/:id" element={<InvoiceEditorPage />} />
              <Route path="sales/pick-queue" element={<PickQueuePage />} />
              <Route path="sales/pick-queue/:id" element={<PickQueuePage />} />
              <Route path="sales/awaiting-invoice" element={<AwaitingInvoicePage />} />
              <Route path="sales/dispatches" element={<DispatchesPage />} />
              <Route path="sales/delivered" element={<DispatchesPage stage="delivered" />} />
              <Route path="sales/dispatches/:id" element={<DispatchPaperPage />} />
              <Route path="sales/scan" element={<ScanPage />} />
              <Route path="sales/packed" element={<PackedPage />} />
              <Route path="sales/packs/:id" element={<PackingSlipPage />} />
              <Route path="purchase/requirements" element={<RequirementsPage />} />
              <Route path="purchase/orders" element={<PurchaseOrdersPage />} />
              <Route path="purchase/orders/new" element={<PurchaseOrderEditorPage />} />
              <Route path="purchase/orders/:id" element={<PurchaseOrderEditorPage />} />
              <Route path="purchase/grns" element={<GrnsPage />} />
              <Route path="purchase/grns/:id" element={<GrnPaperPage />} />
              <Route path="reports" element={<InsightsOverviewPage />} />
              <Route path="reports/custom" element={<CustomReportsPage />} />
              <Route path="reports/custom/:id" element={<CustomReportPage />} />
              <Route path="reports/growth" element={<GrowthPage />} />
              <Route path="reports/team" element={<TeamPage />} />
              <Route path="reports/team/:ownerRef" element={<ScorecardPage />} />
              <Route path="reports/sales-analysis" element={<SalesAnalysisPage />} />
              <Route path="reports/margin" element={<MarginPage />} />
              <Route path="reports/brands" element={<BrandsPage />} />
              <Route path="reports/analytics" element={<CfoAnalyticsPage />} />
              <Route path="reports/export-centre" element={<ExportCentrePage />} />
              <Route path="reports/close-pack" element={<ClosePackPage />} />
              <Route path="reports/desk" element={<DeskPage />} />
              <Route path="reports/data-quality" element={<DataQualityPage />} />
              <Route path="reports/penetration" element={<PenetrationPage />} />
              <Route path="reports/class-grade" element={<ClassGradePage />} />
              <Route path="reports/definitions" element={<DefinitionsPage />} />
              <Route path="reports/exceptions" element={<ExceptionsPage />} />
              <Route path="reports/alerts" element={<AlertsPage />} />
              <Route path="reports/me" element={<MyCfoPage />} />
              <Route path="reports/credit" element={<CreditControlPage />} />
              <Route path="reports/work-lists" element={<WorkListsPage />} />
              <Route path="reports/attendance" element={<InsightsAreaPage area="attendance" />} />
              <Route path="reports/receivables" element={<InsightsAreaPage area="receivables" />} />
              <Route path="reports/sales" element={<InsightsAreaPage area="sales" />} />
              <Route path="reports/sync" element={<InsightsAreaPage area="sync" />} />
              <Route path="analytics" element={<AnalyticsPage />} />
              <Route path="regularizations" element={<RegularizationsPage />} />
              <Route path="team-leave" element={<TeamLeavePage />} />

              {/* Off the sidebar on purpose: reached from the user menu, not
                  from the navigation groups the PRD fixes (§6.1). */}
              <Route path="profile" element={<ProfilePage />} />

              {/* Also off the sidebar, and for the same reason. */}
              <Route path="updates" element={<UpdatesPage />} />

              {/* And this one: reached from the bell in the header (REQ-K-05). */}
              <Route path="notifications" element={<NotificationsPage />} />

              {/* Sample data lives on this route, so it is never built into
                  a production bundle (CLAUDE.md §6). */}
              {import.meta.env.DEV ? (
                <Route path="patterns" element={<PatternsPage />} />
              ) : null}

              {ALL_NAV_ITEMS.filter((item) => !BUILT_ROUTES.has(item.to)).map((item) => (
                <Route key={item.to} path={item.to.slice(1)} element={<PlaceholderPage />} />
              ))}

              <Route path="*" element={<PlaceholderPage />} />
            </Route>
          </Routes>
          </Suspense>
        </ShortcutProvider>
        </SessionGate>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
