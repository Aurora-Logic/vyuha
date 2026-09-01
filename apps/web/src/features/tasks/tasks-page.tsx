import { useState } from 'react';
import { CheckSquareIcon, GearIcon, KanbanIcon, ListBulletsIcon, LockKeyIcon, PaperclipIcon, PlusIcon } from '@phosphor-icons/react';
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
import { SavedViews } from '@/components/shared/saved-views';
import { SearchField } from '@/components/shared/search-field';
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
import { PERMISSIONS, REALTIME_RESOURCES, TASK_DUE_FILTERS, TASK_PRIORITIES, TASK_PRIORITY_LABELS, TASK_SORT_FIELDS, type TaskDueFilter, type TaskPriority } from '@vyuha/shared';

import { BoardColumnsSheet } from './board-columns-sheet';
import { DueDate } from './due-date';
import { TaskBoard } from './task-board';
import { TaskSheet } from './task-sheet';
import { useTaskViewStore, type TaskViewMode } from './task-view-store';
import { emptyTaskDraft, taskToDraft, type Task, type TaskDraft } from './types';
import { useMoveTask, useTask, useTaskBoard, useTasks, type TaskFilters } from './use-tasks';

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
  for (const key of ['q', 'all', 'due', 'priority', 'assignee', 'closed', 'view']) {
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
  const mine = searchParams.get('all') !== '1';
  const dueParam = searchParams.get('due');
  const due: TaskDueFilter = isDueFilter(dueParam) ? dueParam : 'open';
  const includeClosed = searchParams.get('closed') === '1';
  const priorityParam = searchParams.get('priority');
  const priority = TASK_PRIORITIES.find((value) => value === priorityParam);
  const assigneeParam = searchParams.get('assignee') ?? '';
  const viewParam = searchParams.get('view');
  const view: TaskViewMode = viewParam === 'board' || viewParam === 'list' ? viewParam : defaultView;
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

  const list = useTasks({ ...filters, page, ...(sort ? { sort } : {}) }, { enabled: canView && view === 'list' });
  const board = useTaskBoard(filters, { enabled: canView && view === 'board' });
  const open = useTask(canView ? openId : null);
  const move = useMoveTask();

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
  const query = view === 'list' ? list : board;
  const nothing = view === 'list' ? list.isSuccess && rows.length === 0 : board.isSuccess && board.data.lanes.every((l) => l.tasks.length === 0);
  const filtered = Boolean(q) || due !== 'open' || !mine || includeClosed || priority !== undefined || assigneeParam !== '';

  return (
    <>
      <PageHeader
        description={mine ? 'Assigned to you, open, by due date. Every change is audited.' : 'Everyone you can see, by due date. Every change is audited.'}
        action={
          <Button size="sm" onClick={startNew}>
            <PlusIcon data-icon="inline-start" />
            New task
            <ShortcutHint keys="alt+c" className="ml-1 hidden md:inline-flex" />
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {/* Bounded. It had no width of its own, so in a flex row it took every
              pixel the filters left and the toolbar read as one long bar with
              some controls after it (owner, 1 Sep 2026). Notion gives search a
              small fixed slot beside its filters; on a phone it still takes the
              full row, where there is nothing to share it with. */}
          <SearchField
            id="task-search"
            label="Search tasks"
            className="w-full sm:w-56"
            value={draft}
            onValueChange={setDraft}
            placeholder="Title or notes"
          />

          <ToggleGroup
            variant="outline"
            aria-label="Whose tasks"
            value={[mine ? 'mine' : 'all']}
            onValueChange={(value) => {
              const next = value[0];
              if (next === 'mine' || next === 'all') setParam('all', next === 'all' ? '1' : null);
            }}
          >
            <ToggleGroupItem value="mine">Mine</ToggleGroupItem>
            <ToggleGroupItem value="all">Everyone</ToggleGroupItem>
          </ToggleGroup>

          <Select
            value={due}
            onValueChange={(value: string | null) => {
              setParam('due', value === null || value === 'open' ? null : value);
            }}
          >
            <SelectTrigger className="w-36" aria-label="Due">
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

          <Select
            value={priority ?? 'all'}
            onValueChange={(value: string | null) => {
              setParam('priority', value === null || value === 'all' ? null : value);
            }}
          >
            <SelectTrigger className="w-32" aria-label="Priority">
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

          {mine ? null : (
            <Select
              value={assigneeParam === '' ? 'all' : assigneeParam}
              onValueChange={(value: string | null) => {
                setParam('assignee', value === null || value === 'all' ? null : value);
              }}
            >
              <SelectTrigger className="w-40" aria-label="Assignee">
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
          )}

          <Label htmlFor="tasks-closed" className="flex items-center gap-2 text-sm font-normal">
            <Switch
              id="tasks-closed"
              checked={includeClosed}
              onCheckedChange={(next: boolean) => {
                setParam('closed', next ? '1' : null);
              }}
            />
            Show closed
          </Label>

          <div className="ml-auto flex items-center gap-2">
            {/* REQ-V-13. Beside the saved views and before "Columns", which
                configures the board's lanes -- two different things, and the
                labels say which is which: Fields is what a card shows,
                Columns is what the board is made of. */}
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
            {isMobile ? null : (
              <ToggleGroup
                variant="outline"
                aria-label="View"
                value={[view]}
                onValueChange={(value) => {
                  const next = value[0];
                  if (next === 'list' || next === 'board') {
                    setParam('view', next);
                    // REQ-V-05: the choice sticks for this person on this device.
                    setDefaultView(next);
                  }
                }}
              >
                <ToggleGroupItem value="list" aria-label="List view">
                  <ListBulletsIcon />
                </ToggleGroupItem>
                <ToggleGroupItem value="board" aria-label="Board view">
                  <KanbanIcon />
                </ToggleGroupItem>
              </ToggleGroup>
            )}
          </div>
        </div>

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

        {view === 'board' && board.data !== undefined && !nothing ? (
          <TaskBoard
            board={board.data}
            moving={move.isPending}
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
