# Duo Notes

A tiny Notion-like knowledge app for two people. Pages are the base primitive:
each page holds blocks (text, headings, bullets, to-dos, dividers, mini-database
tables, and drawing canvases) edited Notion-style with a "/" insert menu. Both
users share the same pages with live sync.

Zero build: plain HTML/CSS/vanilla JS. No framework, no bundler, no package.json.

## Run locally

```bash
cd duo-notes
python3 -m http.server 8000   # then open http://localhost:8000
```

With an empty `config.js` the app runs in **local-only mode**: no login, data
persisted in `localStorage` only. That is enough to try everything except sync.

## Enable sync (one-time Supabase setup)

1. Create a free project at supabase.com.
2. SQL editor → run:

   ```sql
   create table public.pages (
     id          uuid primary key default gen_random_uuid(),
     parent_id   uuid references public.pages(id) on delete cascade,
     title       text not null default '',
     blocks      jsonb not null default '[]'::jsonb,
     sort_order  double precision not null default 0,
     updated_at  timestamptz not null default now(),
     updated_by  uuid references auth.users(id),
     client_id   text
   );
   create index pages_parent_idx on public.pages(parent_id);
   alter table public.pages enable row level security;
   create policy "authenticated full access" on public.pages
     for all to authenticated using (true) with check (true);
   alter publication supabase_realtime add table public.pages;
   alter table public.pages replica identity full;
   ```

3. Authentication → Users → add the two accounts (email + password,
   auto-confirm on).
4. Authentication → Sign In / Providers → Email → turn **off** "Allow new
   users to sign up".
5. Project Settings → API → copy the Project URL and the `anon` key into
   `config.js`.

The anon key is intended to be committed; RLS is what protects the data.
Never commit the `service_role` key.

Note: free Supabase projects pause after about a week of inactivity. If the
app shows the offline banner and nothing syncs, open the Supabase dashboard
and hit Restore.

## Deploy

`.github/workflows/pages.yml` publishes the repo root to GitHub Pages on every
push to `main`. Enable Pages in the repo settings with Source: GitHub Actions.
Everything committed ships as-is, including `config.js`.

## Architecture

- `app.js` — state (`{pages, currentPageId}`), localStorage cache
  (`duo-notes.cache.v1`), the `persistAndRender()` funnel every mutation goes
  through, sidebar tree, hash routing, boot.
- `editor.js` — block editor: one contenteditable per text block, Enter
  splits / Backspace merges, arrow-key navigation, "/" slash menu,
  Alt+Arrow and drag-handle reorder, plain-text paste.
- `table.js` — the table block: a mini database with typed columns
  (text / checkbox / date / select), add/remove rows and columns, per-column
  sort persisted as view state. Lives entirely inside the block JSON, so it
  syncs for free.
- `icons.js` / `canvas-core.js` / `canvas.js` / `canvas-ui.js` — the drawing
  block. See below.
- `sync.js` — Supabase auth, debounced per-page upsert (last write wins per
  page), realtime `postgres_changes` subscription with self-echo and staleness
  guards, presence hint ("X is also on this page"), offline retry, and the
  ephemeral broadcast channel behind live canvas cursors.
- `index.html` / `styles.css` — login view + app shell, warm notebook theme.

## The drawing block

Insert one with `/draw` (also `/canvas`, `/sketch`, `/diagram`). It renders
inline in the page and **Expand** opens it full screen. Everything lives in the
block's JSON, so a drawing persists and syncs like any other block.

Tools: select (V), pan (H, or hold Space), pencil (P), eraser (E), rectangle (R),
ellipse (O), diamond (D), triangle (G), cylinder (C), arrow (A), line (L), text
(T), sticky note (S), frame (F), and a UML class box. Double-click any shape to
label it, or empty space for free text. `⌘Z` / `⇧⌘Z` undo and redo, `⌘D`
duplicates, `⌘]` / `⌘[` change stacking, arrow keys nudge, `⌘A` selects all.
Escape cancels a tool or selection first, and only closes the drawer when there
is nothing left to cancel.

**Linking is by binding, not coordinates.** Hover a shape and four connector dots
appear on its edges; drag from one to another shape to connect them. Arrows drawn
with the arrow tool also bind when an endpoint lands on a shape. An arrow stores
*which* elements it joins, and its endpoints are recomputed at render time from
where those shapes currently sit — so moving a box re-routes every arrow attached
to it without touching any stored geometry. The **Ends** menu carries the UML
arrowheads (hollow triangle for inheritance, filled diamond for composition,
hollow diamond for aggregation; pair a dashed stroke with an open arrow for
dependency).

**Icons** come from `icons.js`: 20 AWS-style, 8 UML, and 20 generic
infrastructure glyphs. The AWS ones are original simplified approximations in
AWS's category colours, **not** Amazon's official artwork, which is licensed and
would need fetching from outside. When a diagram needs the real thing, use
*Import an SVG…* in the icon picker: paste the markup and it becomes a reusable
icon stored on that canvas. Imports are sanitised (scripts, inline handlers,
external references and `foreignObject` are stripped) before anything is stored.

**Sketchy or crisp** toggles per canvas. Sketch mode derives a deterministic
wobble from each element's id — the same shape always wobbles the same way, so
nothing shimmers on re-render — and sets canvas text in Architects Daughter.
Crisp mode draws true geometry, which reads better for formal diagrams.

Pan and zoom are stored per person in `localStorage`
(`duo-notes.view.<blockId>`), deliberately outside the synced document: if the
camera were shared, one person scrolling would drag the other's viewport.

**Drawing together.** While the drawer is open, a Supabase *broadcast* channel
carries each person's cursor and the element they are currently dragging, so you
see her stroke as it happens rather than after it lands. None of that touches the
database. For the document itself, two guards protect concurrent drawing: an
incoming page update is deferred while a gesture is in flight, and when an update
arrives for a canvas you have unpushed edits on, elements are merged by id rather
than the page being replaced. Element-level last-write-wins means two people
adding different things never lose work; a deletion racing an edit can lose, and
the element comes back.

Export writes a PNG (2×) or a standalone SVG of the drawing's bounds. Text in the
PNG may fall back to a system font, because webfonts don't load inside an SVG
being rasterised; the SVG export is unaffected.

Not in this version: rotating elements, and live cursors on the small inline
canvas (they run in the expanded drawer only).
