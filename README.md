# Duo Notes

A tiny Notion-like knowledge app for two people. Pages are the base primitive:
each page holds blocks (text, headings, bullets, to-dos, dividers, and
mini-database tables) edited Notion-style with a "/" insert menu. Both users
share the same pages with live sync.

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
- `sync.js` — Supabase auth, debounced per-page upsert (last write wins per
  page), realtime `postgres_changes` subscription with self-echo and staleness
  guards, presence hint ("X is also on this page"), offline retry.
- `index.html` / `styles.css` — login view + app shell, warm notebook theme.
