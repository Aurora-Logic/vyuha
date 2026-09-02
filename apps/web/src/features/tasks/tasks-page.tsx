import { useState } from 'react';
import { CheckSquareIcon, GearIcon, ReceiptIcon, CalendarBlankIcon, ChartBarHorizontalIcon, KanbanIcon, SquaresFourIcon, TableIcon, LockKeyIcon, PaperclipIcon, PlusIcon } from '@phosphor-icons/react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { ListSkeleton } from '@/components/shared/list-skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPagination } from '@/components/shared/record-pagination';
import { RecordPresence } from '@/components/shared/presence-avatars';
import { CardFieldsMenu } from './card-fields-menu';
import { useTaskCardFields, type TaskCardField } from './card-fields';
import { EMPTY_VALUE } from '@/lib/format';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { PersonChip } from '@/components/shared/person';
import { CollapsibleSearch } from '@/components/shared/collapsible-search';
import { FilterButton, FilterChips, FilterField, type FilterChip } from '@/components/shared/filter-bar';
import { SavedViews } from '@/components/shared/saved-views';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { useUrlSort } from '@/components/shared/use-url-sort';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { toast } from '@/components/ui/toast';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { useManagerOptions } from '@/features/employees/use-employee-mutations';
import { useIsMobile } from '@/hooks/use-mobile';

import { useSearchDraft } from '@/lib/use-search-draft';
import { useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { MAX_PAGE_SIZE, PERMISSIONS, REALTIME_RESOURCES, TASK_DUE_FILTERS, TASK_PRIORITIES, TASK_PRIORITY_LABELS, TASK_SORT_FIELDS, type TaskDueFilter, type TaskPriority } from '@vyuha/shared';

import { BoardColumnsSheet } from './board-columns-sheet';
import { DueDate } from './due-date';
import { TaskBoard } from './task-board';
import { TaskSheet } from './task-sheet';
import { isTaskViewMode, useTaskViewStore, type TaskViewMode } from './task-view-store';
import { TaskCalendar } from './task-calendar';
import { TaskGallery } from './task-gallery';
import { TaskTimeline } from './task-timeline';
import { emptyTaskDraft, taskToDraft, type Task, type TaskDraft } from './types';
import { DeleteTaskDialog } from './delete-task-dialog';
import { PlaceOrderDialog } from './place-order-dialog';
import { useMoveTask, useSaveTask, useTask, useTaskBoard, useTasks, type TaskFilters } from './use-tasks';

/**
 * My tasks (REQ-V-07), the CRM landing screen: assigned to me, open, by due
 * date — with the filters that turn it into everybody's tasks, a due slice,
 * or the closed ones. List and board are two renderings of one filter set
 * (REQ-V-04): the toggle changes what draws, never what is asked for. The
 * open task is the route, so a notification's link lands on its sheet.
 */

const DUE_LABELS: Record<TaskDueFilter, string> = {
  open: 'All open',
  overdue: 'Overdue',
  today: 'Due today',
  upcoming: 'Upcoming',
  undated: 'No date',
};

/**
 * The linked record, shown inside the title cell rather than as a column of
 * its own — it reads as part of what the task is about. Its own component so
 * it can read the Fields preference, which a column's `cell` callback cannot.
 */
function SubjectHint({ label }: { readonly label: string | null }) {
  const { shown } = useTaskCardFields();
  if (label === null || !shown.subject) return null;
  return <span className="text-muted-foreground truncate text-xs">on {label}</span>;
}

/**
 * REQ-V-13: the columns a task row can carry, keyed so the Fields menu can
 * take any of them away.
 *
 * Title and status stay: a row with neither is not a row, and the status is
 * what a register is scanned for. Everything else is the reader's choice —
 * the same set the board card offers, so turning the supplier off in one
 * place turns it off in both.
 */
const COLUMNS: RecordColumn<Task>[] = [
  {
    key: 'title',
    header: 'Task',
    sortField: 'title',
    cell: (row) => (
      <span className="flex min-w-0 items-center gap-2">
        <span className={row.isClosed ? 'text-muted-foreground line-through' : 'font-medium'}>{row.title}</span>
        <SubjectHint label={row.subjectLabel} />
        {/* REQ-U-10: the owner's words were "highlight if someone is working
            on any task". The list is where most people read tasks, so it has
            to be here and not only on the board. */}
        <RecordPresence resource={REALTIME_RESOURCES.TASK} recordId={row.id} />
      </span>
    ),
  },
  { key: 'due', header: 'Due', sortField: 'dueDate', cell: (row) => <DueDate value={row.dueDate} closed={row.isClosed} /> },
  { key: 'status', header: 'Status', cell: (row) => <Badge variant="outline">{row.columnName}</Badge> },
  {
    key: 'priority',
    header: 'Priority',
    sortField: 'priority',
    cell: (row) => TASK_PRIORITY_LABELS[row.priority],
    secondary: true,
  },
  { key: 'assignee', header: 'Assigned to', cell: (row) => <PersonChip name={row.assigneeName} />, secondary: true },
  // REQ-V-09 / REQ-V-10, all three secondary: they fold away on a phone
  // rather than pushing the title and the due date off the row.
  { key: 'party', header: 'Customer', cell: (row) => row.partyName ?? EMPTY_VALUE, secondary: true },
  { key: 'vendor', header: 'Supplier', cell: (row) => row.vendorName ?? EMPTY_VALUE, secondary: true },
  {
    key: 'items',
    header: 'Items',
    cell: (row) =>
      row.items.length === 0 ? (
        EMPTY_VALUE
      ) : (
        // The names, not a count: this column exists to be scanned, and "2
        // items" makes the reader open the task to learn which two.
        <span className="truncate">{row.items.map((item) => item.itemName).join(', ')}</span>
      ),
    secondary: true,
  },
  {
    key: 'attachments',
    header: 'Files',
    cell: (row) =>
      row.attachmentCount === 0 ? (
        EMPTY_VALUE
      ) : (
        <span className="flex items-center gap-1 tabular-nums">
          <PaperclipIcon className="text-muted-foreground shrink-0" />
          {row.attachmentCount}
        </span>
      ),
    secondary: true,
  },
];

/** Which columns the Fields menu governs; the rest are always on. */
const OPTIONAL_COLUMNS: Partial<Record<string, TaskCardField>> = {
  due: 'due',
  priority: 'priority',
  assignee: 'assignee',
  party: 'party',
  vendor: 'vendor',
  items: 'items',
  attachments: 'attachments',
};

function visibleColumns(shown: Record<TaskCardField, boolean>): RecordColumn<Task>[] {
  return COLUMNS.filter((column) => {
    const governed = OPTIONAL_COLUMNS[column.key];
    return governed === undefined || shown[governed];
  });
}

/** What a saved view keeps: the filter and view keys, never the transients (page, the open sheet, a preset subject). */
function viewQuery(params: URLSearchParams): string {
  const kept = new URLSearchParams();
  for (const key of ['q', 'mine', 'due', 'priority', 'assignee', 'closed', 'view']) {
    const value = params.get(key);
    if (value !== null && value !== '') kept.set(key, value);
  }
  return kept.toString();
}

function isDueFilter(value: string | null): value is TaskDueFilter {
  return TASK_DUE_FILTERS.some((f) => f === value);
}

export function TasksPage() {
  const canViewSelf = usePermission(PERMISSIONS.CRM_TASK_VIEW_SELF);
  const canViewTeam = usePermission(PERMISSIONS.CRM_TASK_VIEW_TEAM);
  const canView = canViewSelf || canViewTeam;
  const canConfigure = usePermission(PERMISSIONS.SETTINGS_MANAGE);
  const [searchParams, setSearchParams] = useSearchParams();
  const params = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const defaultView = useTaskViewStore((s) => s.defaultView);
  const setDefaultView = useTaskViewStore((s) => s.setDefaultView);
  const [configuring, setConfiguring] = useState(false);

  const q = searchParams.get('q') ?? '';
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  // "Mine" is the landing default (REQ-V-07); `?all=1` widens to everyone the caller may see.
  // Everyone's tasks, open and closed, unless the reader narrows it (owner,
  // 2 Sep 2026: "keep default as all tasks not mine task, all task including
  // close and open"). The board is read to see what the floor is doing, not
  // to see one desk; `?mine=1` is how a person narrows to their own.
  const mine = searchParams.get('mine') === '1';
  const dueParam = searchParams.get('due');
  const due: TaskDueFilter = isDueFilter(dueParam) ? dueParam : 'open';
  const includeClosed = searchParams.get('closed') !== '0';
  const priorityParam = searchParams.get('priority');
  const priority = TASK_PRIORITIES.find((value) => value === priorityParam);
  const assigneeParam = searchParams.get('assignee') ?? '';
  const viewParam = searchParams.get('view');
  const view: TaskViewMode = isTaskViewMode(viewParam) ? viewParam : defaultView;
  // Calendar, gallery and timeline are whole-set views: a month with only
  // the first 25 of its tasks on it is a lie, not a page. They ask for the
  // server's maximum and say so below when even that is not everything.
  const wholeSet = view === 'calendar' || view === 'gallery' || view === 'timeline';
  // REQ-V-13: the same preference governs the board card and this table, so
  // hiding the supplier hides it in both renderings of the one query.
  const { shown: shownFields } = useTaskCardFields();
  const columns = visibleColumns(shownFields);
  const openId = params.id ?? null;
  const creating = searchParams.get('new') === '1';
  const subjectType = searchParams.get('subjectType') ?? '';
  const subjectId = searchParams.get('subjectId') ?? '';

  const [draft, setDraft] = useSearchDraft();

  function setParam(name: string, value: string | null) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === null) next.delete(name);
        else next.set(name, value);
        if (name !== 'page' && name !== 'view') next.delete('page');
        return next;
      },
      { replace: true },
    );
  }

  const filters: TaskFilters = {
    ...(q ? { q } : {}),
    ...(mine ? { mine: true } : {}),
    ...(due === 'open' ? {} : { due }),
    ...(priority === undefined ? {} : { priority }),
    ...(assigneeParam === '' || mine ? {} : { assigneeId: assigneeParam }),
    ...(includeClosed ? { includeClosed: true } : {}),
    ...(subjectType && subjectId ? { subjectType, subjectId } : {}),
  };
  const owners = useManagerOptions();
  const { sort, activeSort, onSortChange } = useUrlSort(TASK_SORT_FIELDS);

  const list = useTasks(
    { ...filters, page, ...(sort ? { sort } : {}), ...(wholeSet ? { pageSize: MAX_PAGE_SIZE, page: 1 } : {}) },
    { enabled: canView && (view === 'list' || wholeSet) },
  );
  const board = useTaskBoard(filters, { enabled: canView && view === 'board' });
  const open = useTask(canView ? openId : null);
  const move = useMoveTask();
  const save = useSaveTask();
  const canManage = usePermission(PERMISSIONS.CRM_TASK_MANAGE);
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);
  const [placingOrder, setPlacingOrder] = useState(false);

  function startNew() {
    setParam('new', '1');
  }

  function closeSheet() {
    const next = new URLSearchParams(window.location.search);
    next.delete('new');
    const search = next.toString();
    void navigate(`/tasks${search ? `?${search}` : ''}`, { replace: true });
  }

  useShortcut({
    id: 'tasks.create',
    keys: 'alt+c',
    label: 'New task',
    scope: 'screen',
    when: () => canView,
    run: startNew,
  });

  const sheetDraft: TaskDraft | null = creating
    ? emptyTaskDraft(subjectType && subjectId ? { subjectType, subjectId, subjectLabel: searchParams.get('subjectLabel') } : {})
    : open.data !== undefined && openId !== null
      ? taskToDraft(open.data)
      : null;

  if (!canView) {
    return (
      <>
        <PageHeader description="What you are chasing, by due date." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view tasks</EmptyTitle>
            <EmptyDescription>This needs crm.task.view.self. Ask an administrator for a role that carries it.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta ?? null;
  const query = view === 'board' ? board : list;
  const openTask = (task: Task) => {
    void navigate(`/tasks/${task.id}${window.location.search}`);
  };
  const nothing =
    view === 'board'
      ? board.isSuccess && board.data.lanes.every((l) => l.tasks.length === 0)
      : list.isSuccess && rows.length === 0;
  const filtered = Boolean(q) || due !== 'open' || mine || !includeClosed || priority !== undefined || assigneeParam !== '';

  /**
   * What is actually filtered, as chips and as the count on the Filter button.
   *
   * One list drives both, so the badge can never say two while three chips are
   * on screen. Search is deliberately not here: it has its own visible field
   * with its own clear, and a chip for it would be the same filter twice.
   */
  const activeFilters: FilterChip[] = [
    ...(mine
      ? [{ key: 'mine', label: 'Whose', value: 'Mine', onClear: () => { setParam('mine', null); } }]
      : []),
    ...(due === 'open'
      ? []
      : [{ key: 'due', label: 'Due', value: DUE_LABELS[due], onClear: () => { setParam('due', null); } }]),
    ...(priority === undefined
      ? []
      : [{ key: 'priority', label: 'Priority', value: TASK_PRIORITY_LABELS[priority], onClear: () => { setParam('priority', null); } }]),
    ...(assigneeParam === ''
      ? []
      : [{
          key: 'assignee',
          label: 'Assignee',
          value: (owners.data ?? []).find((o) => o.id === assigneeParam)?.name ?? 'Someone',
          onClear: () => { setParam('assignee', null); },
        }]),
    ...(includeClosed
      ? []
      : [{ key: 'closed', label: 'Closed', value: 'Hidden', onClear: () => { setParam('closed', null); } }]),
  ];

  const clearFilters = () => {
    for (const chip of activeFilters) chip.onClear();
  };

  return (
    <>
      <PageHeader
        description={mine ? 'Assigned to you, by due date. Every change is audited.' : 'Everyone you can see, open and closed, by due date. Every change is audited.'}
        action={
          <span className="flex items-center gap-2">
            {/* REQ-V-17. First and solid, because taking an order is the thing
                somebody opens this screen in a hurry to do; a task is the
                slower, more considered one. */}
            {canManage ? (
              <Button size="sm" onClick={() => { setPlacingOrder(true); }}>
                <ReceiptIcon data-icon="inline-start" />
                Place order
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={startNew}>
              <PlusIcon data-icon="inline-start" />
              New task
              <ShortcutHint keys="alt+c" className="ml-1 hidden md:inline-flex" />
            </Button>
          </span>
        }
      />

      <div className="flex flex-col gap-3">
        {/* One row, and mostly empty (owner, 1 Sep 2026). Read off Notion: a
            few icon-sized controls, the filter editor behind one of them, and
            what is actually filtered shown as chips underneath -- so a screen
            with nothing filtered carries no filter furniture at all. It was a
            search box, a toggle, three dropdowns and a switch, always, wrapped
            onto two rows. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <CollapsibleSearch
            id="task-search"
            label="Search tasks"
            value={draft}
            onValueChange={setDraft}
            placeholder="Title or notes"
          />

          <FilterButton
            active={activeFilters.length}
            onClearAll={clearFilters}
            description="Narrows every view of this list, including the board and the calendar."
          >
            <FilterField label="Whose">
              <ToggleGroup
                variant="outline"
                aria-label="Whose tasks"
                value={[mine ? 'mine' : 'all']}
                onValueChange={(value) => {
                  const next = value[0];
                  if (next === 'mine' || next === 'all') setParam('mine', next === 'mine' ? '1' : null);
                }}
              >
                <ToggleGroupItem value="mine">Mine</ToggleGroupItem>
                <ToggleGroupItem value="all">Everyone</ToggleGroupItem>
              </ToggleGroup>
            </FilterField>

            <FilterField label="Due" htmlFor="task-filter-due">
              <Select
                value={due}
                onValueChange={(value: string | null) => {
                  setParam('due', value === null || value === 'open' ? null : value);
                }}
              >
                <SelectTrigger id="task-filter-due" aria-label="Due">
                  <SelectValue>{(value: TaskDueFilter) => DUE_LABELS[value]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {TASK_DUE_FILTERS.map((f) => (
                    <SelectItem key={f} value={f}>
                      {DUE_LABELS[f]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterField>

            <FilterField label="Priority" htmlFor="task-filter-priority">
              <Select
                value={priority ?? 'all'}
                onValueChange={(value: string | null) => {
                  setParam('priority', value === null || value === 'all' ? null : value);
                }}
              >
                <SelectTrigger id="task-filter-priority" aria-label="Priority">
                  <SelectValue>{(value: string) => (value === 'all' ? 'Any priority' : TASK_PRIORITY_LABELS[value as TaskPriority])}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any priority</SelectItem>
                  {TASK_PRIORITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {TASK_PRIORITY_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterField>

            {/* "Mine" already answers who, so the picker would be a control
                that can only contradict the one above it. */}
            {mine ? null : (
              <FilterField label="Assignee" htmlFor="task-filter-assignee">
                <Select
                  value={assigneeParam === '' ? 'all' : assigneeParam}
                  onValueChange={(value: string | null) => {
                    setParam('assignee', value === null || value === 'all' ? null : value);
                  }}
                >
                  <SelectTrigger id="task-filter-assignee" aria-label="Assignee">
                    <SelectValue>{(value: string) => (value === 'all' ? 'Any assignee' : ((owners.data ?? []).find((o) => o.id === value)?.name ?? 'Assignee'))}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any assignee</SelectItem>
                    {(owners.data ?? []).map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterField>
            )}

            <FilterField label="Closed tasks" htmlFor="tasks-closed">
              <Label htmlFor="tasks-closed" className="flex items-center gap-2 text-sm font-normal">
                <Switch
                  id="tasks-closed"
                  checked={includeClosed}
                  onCheckedChange={(next: boolean) => {
                    // Closed are shown by default now, so the param records
                    // only the narrowing: absent means shown.
                    setParam('closed', next ? null : '0');
                  }}
                />
                Show closed
              </Label>
            </FilterField>
          </FilterButton>

          <div className="ml-auto flex items-center gap-1.5">
            {/* REQ-V-13. Fields is what a card shows; Columns is what the
                board is made of -- two different things, and the labels say
                which is which. */}
            <CardFieldsMenu />
            <SavedViews
              storageKey="vyuha.views.tasks"
              current={viewQuery(searchParams)}
              onApply={(next) => {
                void navigate(`/tasks${next ? `?${next}` : ''}`, { replace: true });
              }}
            />
            {canConfigure ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setConfiguring(true);
                }}
              >
                <GearIcon data-icon="inline-start" />
                Columns
              </Button>
            ) : null}
            {/* Five layouts, the way Notion's Layout picker offers them. Still
                hidden on a phone: five icon buttons plus the rest is most of a
                360px row, and the board and timeline are not what anyone
                reaches for on one. */}
            {isMobile ? null : (
              <ToggleGroup
                variant="outline"
                aria-label="View"
                value={[view]}
                onValueChange={(value) => {
                  const next = value[0] ?? null;
                  if (isTaskViewMode(next)) {
                    setParam('view', next);
                    // REQ-V-05: the choice sticks for this person on this device.
                    setDefaultView(next);
                  }
                }}
              >
                <ToggleGroupItem value="list" aria-label="Table view">
                  <TableIcon />
                </ToggleGroupItem>
                <ToggleGroupItem value="board" aria-label="Board view">
                  <KanbanIcon />
                </ToggleGroupItem>
                <ToggleGroupItem value="calendar" aria-label="Calendar view">
                  <CalendarBlankIcon />
                </ToggleGroupItem>
                <ToggleGroupItem value="gallery" aria-label="Gallery view">
                  <SquaresFourIcon />
                </ToggleGroupItem>
                <ToggleGroupItem value="timeline" aria-label="Timeline view">
                  <ChartBarHorizontalIcon />
                </ToggleGroupItem>
              </ToggleGroup>
            )}
          </div>
        </div>

        <FilterChips chips={activeFilters} />

        {query.isPending ? <ListSkeleton rows={4} label="Loading tasks" /> : null}

        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="tasks"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {nothing ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CheckSquareIcon />
              </EmptyMedia>
              <EmptyTitle>{filtered ? 'No task matches that' : 'Nothing to chase'}</EmptyTitle>
              <EmptyDescription>
                {filtered
                  ? 'Try another due slice, include closed tasks, or widen to everyone.'
                  : 'Nothing is assigned to you and open. Add one, or enjoy the quiet.'}
              </EmptyDescription>
            </EmptyHeader>
            {!filtered ? (
              <EmptyContent>
                <Button size="sm" onClick={startNew}>
                  <PlusIcon data-icon="inline-start" />
                  New task
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : null}

        {view === 'list' && rows.length > 0 ? (
          <>
            <RecordTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row.id}
              sort={activeSort}
              onSortChange={onSortChange}
              mobilePrimary={(row) => row.title}
              mobileStatus={(row) => <Badge variant="outline">{row.columnName}</Badge>}
              mobileSupporting={(row) => (
                <span className="flex flex-wrap gap-x-2">
                  <DueDate value={row.dueDate} closed={row.isClosed} />
                  {row.assigneeName === null ? null : <PersonChip name={row.assigneeName} tiny />}
                </span>
              )}
              onRowActivate={(row) => {
                void navigate(`/tasks/${row.id}${window.location.search}`);
              }}
            />
            {meta !== null && meta.total > meta.pageSize ? (
              <RecordPagination page={meta.page} pageSize={meta.pageSize} total={meta.total} />
            ) : null}
          </>
        ) : null}

        {wholeSet && rows.length > 0 ? (
          <>
            {view === 'calendar' ? <TaskCalendar tasks={rows} onOpen={openTask} /> : null}
            {view === 'gallery' ? <TaskGallery tasks={rows} onOpen={openTask} /> : null}
            {view === 'timeline' ? <TaskTimeline tasks={rows} onOpen={openTask} /> : null}
            {/* Said out loud rather than truncated in silence: these views draw
                what they were given, and the server will not give more than
                one page of this size. */}
            {meta !== null && meta.total > rows.length ? (
              <p className="text-muted-foreground text-xs">
                Showing {rows.length} of {meta.total}. Narrow the filters to see the rest.
              </p>
            ) : null}
          </>
        ) : null}

        {view === 'board' && board.data !== undefined && !nothing ? (
          <TaskBoard
            board={board.data}
            moving={move.isPending}
            {...(canManage
              ? {
                  onSetPriority: (task: Task, priority: TaskPriority) => {
                    save.mutate(
                      { ...taskToDraft(task), priority },
                      {
                        onSuccess: () => {
                          toast.add({ type: 'success', title: `${task.title} is now ${TASK_PRIORITY_LABELS[priority].toLowerCase()} priority` });
                        },
                        onError: (error) => {
                          toast.add({ type: 'error', title: 'Could not change the priority', description: error.message });
                        },
                      },
                    );
                  },
                  // Through the same confirm dialog the sheet uses. A right
                  // click is a shortcut to the action, never a shortcut past
                  // the confirmation for a destructive one.
                  onDelete: (task: Task) => {
                    setDeleting({ id: task.id, title: task.title });
                  },
                }
              : {})}
            onOpen={(task) => {
              void navigate(`/tasks/${task.id}${window.location.search}`);
            }}
            onMove={(task, columnId) => {
              const lane = board.data?.lanes.find((l) => l.column.id === columnId);
              move.mutate(
                { id: task.id, columnId },
                {
                  onSuccess: (moved) => {
                    toast.add({
                      type: 'success',
                      title: moved.isClosed && !task.isClosed ? 'Task done' : `Moved to ${lane?.column.name ?? moved.columnName}`,
                      description: moved.title,
                    });
                  },
                  onError: (error) => {
                    toast.add({ type: 'error', title: 'Could not move the task', description: error.message });
                  },
                },
              );
            }}
          />
        ) : null}
      </div>

      {openId !== null && open.isError ? (
        <QueryErrorAlert
          error={open.error}
          subject="that task"
          onRetry={() => {
            void open.refetch();
          }}
        />
      ) : null}

      <PlaceOrderDialog
        open={placingOrder}
        onOpenChange={setPlacingOrder}
        onPlaced={(taskId) => {
          // Straight into the order that was just placed, which is where the
          // convert-to-sales-order button lives.
          void navigate(`/tasks/${taskId}`);
        }}
      />

      <DeleteTaskDialog
        target={deleting}
        onOpenChange={(isOpen) => {
          if (!isOpen) setDeleting(null);
        }}
      />

      <TaskSheet
        draft={sheetDraft}
        onOpenChange={(isOpen) => {
          if (!isOpen) closeSheet();
        }}
      />
      <BoardColumnsSheet open={configuring} onOpenChange={setConfiguring} />
    </>
  );
}
