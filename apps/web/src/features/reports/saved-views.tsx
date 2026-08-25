import { useState } from 'react';
import { BookmarkSimpleIcon, TrashIcon, UsersThreeIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { SAVED_VIEW_NAME_MAX, type SavedView, type SavedViewConfig } from '@vyuha/shared';

/**
 * REQ-J-01's saved views: the current filters, columns and sort under a name.
 *
 * Saving over an existing name replaces it, which is what the server does and
 * what the reader expects from something called "save". The dialog says so
 * rather than surprising them, and the list separates their own views from the
 * ones a colleague shared.
 */

interface SavedViewsProps {
  views: readonly SavedView[];
  isLoading: boolean;
  currentConfig: SavedViewConfig;
  onApply: (view: SavedView) => void;
  onSave: (input: { name: string; isShared: boolean; config: SavedViewConfig }) => Promise<void>;
  onDelete: (view: SavedView) => Promise<void>;
  isSaving: boolean;
}

export function SavedViews({
  views,
  isLoading,
  currentConfig,
  onApply,
  onSave,
  onDelete,
  isSaving,
}: SavedViewsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);

  const own = views.filter((view) => view.isOwn);
  const fromOthers = views.filter((view) => !view.isOwn);
  const existing = own.some((view) => view.name.toLowerCase() === name.trim().toLowerCase());

  async function save() {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    // The dialog stays open on failure, holding the name the user typed;
    // an unhandled rejection here closed nothing and said nothing.
    try {
      await onSave({ name: trimmed, isShared: shared, config: currentConfig });
    } catch (error: unknown) {
      toast.add({
        type: 'error',
        title: 'The view could not be saved',
        description: error instanceof Error ? error.message : 'Try again in a moment.',
      });
      return;
    }
    setDialogOpen(false);
    setName('');
    setShared(false);
    toast.add({
      type: 'success',
      title: existing ? 'View updated' : 'View saved',
      description: trimmed,
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" className="gap-2">
              <BookmarkSimpleIcon data-icon="inline-start" />
              <span className="hidden sm:inline">Views</span>
              {views.length > 0 ? (
                <span className="text-muted-foreground tabular-nums">{views.length}</span>
              ) : null}
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem
            onClick={() => {
              setDialogOpen(true);
            }}
          >
            <BookmarkSimpleIcon />
            Save current view
          </DropdownMenuItem>

          {isLoading ? (
            <>
              <DropdownMenuSeparator />
              {/* Base UI refuses a label outside a group; a bare label here crashed the screen the moment the menu opened while views were still loading. */}
              <DropdownMenuGroup>
                <DropdownMenuLabel>Loading views</DropdownMenuLabel>
              </DropdownMenuGroup>
            </>
          ) : null}

          {own.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Mine</DropdownMenuLabel>
                {own.map((view) => (
                  <DropdownMenuItem
                    key={view.id}
                    onClick={() => {
                      onApply(view);
                    }}
                  >
                    <span className="flex-1 truncate">{view.name}</span>
                    {view.isShared ? <UsersThreeIcon /> : null}
                    {/* A nested button inside a menu item would be a control
                        inside a control; the delete is its own item below the
                        name so both are reachable by keyboard. */}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </>
          ) : null}

          {fromOthers.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Shared with me</DropdownMenuLabel>
                {fromOthers.map((view) => (
                  <DropdownMenuItem
                    key={view.id}
                    onClick={() => {
                      onApply(view);
                    }}
                  >
                    <span className="flex-1 truncate">{view.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </>
          ) : null}

          {own.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Remove</DropdownMenuLabel>
                {own.map((view) => (
                  <DropdownMenuItem
                    key={`delete-${view.id}`}
                    variant="destructive"
                    onClick={() => {
                      void onDelete(view).then(
                        () => {
                          toast.add({ type: 'success', title: 'View removed', description: view.name });
                        },
                        (error: unknown) => {
                          toast.add({
                            type: 'error',
                            title: 'The view could not be removed',
                            description: error instanceof Error ? error.message : view.name,
                          });
                        },
                      );
                    }}
                  >
                    <TrashIcon />
                    <span className="truncate">{view.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </>
          ) : null}

          {!isLoading && views.length === 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
              <DropdownMenuLabel className="text-muted-foreground font-normal">
                No saved views yet.
              </DropdownMenuLabel>
              </DropdownMenuGroup>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save this view</DialogTitle>
            <DialogDescription>
              Stores the current filters, columns and sort. Saving under a name you already use
              replaces that view.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="saved-view-name">Name</Label>
              <Input
                id="saved-view-name"
                value={name}
                maxLength={SAVED_VIEW_NAME_MAX}
                placeholder="Late arrivals, this month"
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="saved-view-shared" className="font-normal">
                Share with everyone who can see this report
              </Label>
              <Switch id="saved-view-shared" checked={shared} onCheckedChange={setShared} />
            </div>
          </div>

          <DialogFooter className="flex-row justify-end gap-2">
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button
              disabled={name.trim().length === 0 || isSaving}
              onClick={() => {
                void save();
              }}
            >
              {existing ? 'Replace view' : 'Save view'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
