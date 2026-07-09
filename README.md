# Daily Ledger

A serverless, mobile-first daily ledger for small businesses that buy and sell physical
goods — track expenses, purchases, and sales, see daily profit and monthly profitability
instantly, and export/import everything as Excel. No backend, no database, 100%
client-side.

Built to replace a paper notebook for a small business owner. The brief was simple: fast
daily data entry, correct math, zero moving parts to maintain, and an interface simple
enough for a non-technical, older primary user.

## Features

- Daily form (Gastos / Compras / Ventas) as a progressive accordion — one section open
  at a time, so a first-time user is never looking at a wall of fields
- Editable, reusable provider/buyer/expense-category lists (fully user-managed, not
  hardcoded)
- Automatic daily profit and monthly profitability calculations, with a division-by-zero
  guard so the numbers never show `NaN`/`Infinity`
- Data is saved to `localStorage` immediately — no "did I save?" anxiety, survives a
  page refresh
- One-click Excel export/import (built on [SheetJS](https://sheetjs.com/), vendored
  locally — no runtime CDN dependency) for record-keeping and month-to-month continuity
- "Cerrar mes" (close the month): exports the month's Excel and clears the local list in
  one step, kept deliberately separate from a plain export so exporting never has a
  destructive side effect
- Optional one-click Google Drive sync — once connected, every export also uploads to a
  shared Drive folder automatically, implemented entirely client-side via OAuth (no
  custom backend, no server-side token storage)
- Mobile-first, large touch targets, Spanish UI, minimal steps

## Why it's interesting technically

- Zero backend, zero database, zero hosting cost beyond static file serving (this whole
  app is a handful of static files — deploy it anywhere that serves HTML)
- Vendored dependencies — no runtime CDN reliance, one less way for the app to break
- A browser-based test suite (`tests.html`) instead of a Node toolchain — the app has no
  build step, so the tests run the exact same way the app does: loaded via `<script>`
  tags in a real browser
- Built iteratively from real usage feedback — several of the more interesting design
  decisions (forced-vs-optional export, per-day currency handling, the "close the month"
  action) came directly from watching how the actual users worked with it day to day,
  not from a spec written in advance

## Running it locally

No build step, no dependencies to install. Any static file server works:

```bash
python3 -m http.server 8811
# open http://localhost:8811/index.html
```

Run the test suite by opening `http://localhost:8811/tests.html` in a browser.

## Google Drive sync (optional)

This is opt-in and the app works perfectly well without it — `Conectar Google Drive`
just won't appear until you configure it. To enable it:

1. Create a Google Cloud project and enable the **Google Drive API**.
2. Configure the OAuth consent screen (External, add yourself as a test user — no
   Google verification needed for a small known group of users).
3. Create an OAuth 2.0 **Client ID** (Web application), and add your app's URL (plus
   `http://localhost:PORT` for local dev) as an **Authorized JavaScript origin**.
4. Create or choose a shared Drive folder, copy its ID from the folder's URL
   (`.../folders/<FOLDER_ID>`), and share it with **Editor** access to whoever will use
   the app.
5. Open `drive.js` and replace `CLIENT_ID` and `FOLDER_ID` at the top of the file with
   your own values.

Each user authorizes their own Google account the first time they click "Conectar
Google Drive" — there's no shared secret and no server holding anyone's credentials.

## Customizing for your own business

- **Starter provider/buyer/expense lists**: edit the `providers`, `buyers`, and
  `gastoNames` arrays near the top of `app.js`. These are just starting suggestions —
  the app lets you add or remove names from within the UI too.
- **Branding**: colors live as CSS custom properties at the top of `style.css`
  (`--navy-dark`, `--orange`, etc.). Swap them for your own palette.
- **Currency**: this version is colones-only by design (a real client explicitly asked
  to remove a dollar option that added friction with no payoff). `calc.js` still
  supports a `currency`/`fxRate` conversion path internally if you want to reintroduce
  multi-currency support — it's just not wired up to the UI.

## Project structure

```
index.html      entry point, markup
app.js          UI orchestration, state, event handling
calc.js         pure calculation functions (no DOM access)
storage.js      localStorage persistence (draft + saved days)
xlsx-io.js      Excel export/import via SheetJS
drive.js        optional Google Drive OAuth + upload
style.css       styles, brand tokens
manifest.json   PWA manifest (Add to Home Screen)
vendor/         vendored SheetJS build
tests.html/js   browser-based test suite
```

## License

MIT — see [LICENSE](LICENSE).
