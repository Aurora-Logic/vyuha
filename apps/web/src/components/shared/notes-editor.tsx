import { useState } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

import { renderMarkdown } from './markdown';

/**
 * Notes that can be formatted, without a rich-text dependency (owner,
 * 31 Aug 2026).
 *
 * Write and Preview rather than a WYSIWYG toolbar: what is stored stays the
 * text the person typed, so a note is still readable in an export, in the
 * database, and in a screen that has not been taught about formatting. The
 * preview renders through `renderMarkdown`, which escapes first and only
 * then introduces its own tags -- see the note in `markdown.ts` for why that
 * makes `dangerouslySetInnerHTML` honest here.
 *
 * `.typeset` is the container the workspace already styles rendered prose
 * with, so the preview reads like the rest of the product rather than like a
 * browser default.
 */
export function NotesEditor({
  id,
  value,
  onValueChange,
  rows = 6,
  placeholder,
}: {
  id: string;
  value: string;
  onValueChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  const [tab, setTab] = useState('write');
  return (
    <Tabs value={tab} onValueChange={(next: string | null) => { if (next !== null) setTab(next); }}>
      <TabsList>
        <TabsTrigger value="write">Write</TabsTrigger>
        <TabsTrigger value="preview">Preview</TabsTrigger>
      </TabsList>
      <TabsContent value="write">
        <Textarea
          id={id}
          rows={rows}
          value={value}
          placeholder={placeholder}
          onChange={(event) => { onValueChange(event.target.value); }}
        />
        <p className="text-muted-foreground mt-1 text-xs">
          **bold**, *italic*, `code`, [link](https://…), # heading, - bullets, 1. numbers.
        </p>
      </TabsContent>
      <TabsContent value="preview">
        {value.trim() === '' ? (
          <p className="text-muted-foreground text-sm">Nothing written yet.</p>
        ) : (
          <div
            className="typeset typeset-docs text-sm"
            // Safe by construction: renderMarkdown escapes every character of
            // input before it emits any tag of its own.
            dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }}
          />
        )}
      </TabsContent>
    </Tabs>
  );
}
