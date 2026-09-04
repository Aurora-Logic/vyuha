import { useState } from 'react';
import { BookmarkSimpleIcon, CheckIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';

import { Form } from '@/components/shared/form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

/**
 * Saved views (the Notion idiom): the current filters, search and view mode
 * of a screen, kept under a name and reapplied in one click. A view is the
 * screen's query string, so anything the URL can say a view can hold, and a
 * view applied is just navigation — nothing else to invalidate. Kept on
 * this device (localStorage), per screen.
 */

export interface SavedView {
  readonly name: string;
  /** The screen's query string, sans transient keys; '' is a valid view (everything default). */
  readonly query: string;
}

function readViews(storageKey: string): SavedView[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is SavedView => typeof v === 'object' && v !== null && typeof (v as SavedView).name === 'string' && typeof (v as SavedView).query === 'string');
  } catch {
    return [];
  }
}

function writeViews(storageKey: string, views: SavedView[]) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(views));
  } catch {
    // A locked-down browser forgets; the control still works for the session.
  }
}

export function SavedViews({ storageKey, current, onApply }: { storageKey: string; current: string; onApply: (query: string) => void }) {
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<SavedView[]>(() => readViews(storageKey));
  const [name, setName] = useState('');
  const active = views.find((v) => v.query === current);

  function save() {
    const trimmed = name.trim();
    if (trimmed === '') return;
    const next = [...views.filter((v) => v.name !== trimmed), { name: trimmed, query: current }];
    setViews(next);
    writeViews(storageKey, next);
    setName('');
  }
  function remove(view: SavedView) {
    const next = views.filter((v) => v.name !== view.name);
    setViews(next);
    writeViews(storageKey, next);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant={active === undefined ? 'outline' : 'default'}
            aria-label="Saved views"
            data-guide="screen.saved-views"
          >
            <BookmarkSimpleIcon data-icon="inline-start" />
            <span className="max-md:sr-only">{active?.name ?? 'Views'}</span>
          </Button>
        }
      />
      <PopoverContent align="end" className="w-72 p-2">
        <div className="flex flex-col gap-0.5">
          {views.length === 0 ? <p className="text-muted-foreground px-2 py-1.5 text-xs">Nothing saved yet. Set the filters the way you like them, name the view below.</p> : null}
          {views.map((view) => (
            <div key={view.name} className="group flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className={cn('h-8 flex-1 justify-start font-normal', view.query === current && 'font-medium')}
                onClick={() => {
                  onApply(view.query);
                  setOpen(false);
                }}
              >
                {view.query === current ? <CheckIcon data-icon="inline-start" /> : <BookmarkSimpleIcon data-icon="inline-start" className="text-muted-foreground" />}
                <span className="truncate">{view.name}</span>
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete the view ${view.name}`}
                className="text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                onClick={() => {
                  remove(view);
                }}
              >
                <TrashIcon />
              </Button>
            </div>
          ))}
        </div>
        <Separator className="my-2" />
        <Form
          className="flex items-center gap-1.5"
          onSubmit={() => {
            save();
          }}
        >
          <Input value={name} placeholder="Save current view as…" aria-label="Name for the current view" className="h-8" onChange={(event) => { setName(event.target.value); }} />
          <Button type="submit" size="icon-sm" variant="outline" aria-label="Save the current view" disabled={name.trim() === ''}>
            <PlusIcon />
          </Button>
        </Form>
      </PopoverContent>
    </Popover>
  );
}
