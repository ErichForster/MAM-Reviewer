# Austruss — MAM / QAM Review Tool

MAM / QAM / YAM review tool. Reviews and templates live in an online
database; every reviewer signs in with their name and a 4-digit PIN.

## Structure

- `public/index.html` — the whole page (HTML, CSS and JavaScript inline,
  including the bundled docx/jsPDF libraries, so it's ~1 MB). No build step.
- `worker.js` — Cloudflare Worker `austruss-mam`. Serves `public/` and hands
  `/api/*` to the `Reviews` Durable Object, which keeps users, sessions,
  reviews and templates in its SQLite storage. Same PIN sign-in and lock-out
  as the Austruss Hub (`Code/Austruss-Hub/hub.js`).
- `wrangler.jsonc` — `mam.austrussapps.com` + workers.dev. No secrets.

### API (all JSON, cookie `mam_session`)

- `GET /api/me`, `POST /api/setup` (first person = admin), `/api/login`, `/api/logout`
- `GET /api/data` — every review, `saved` (id → `{updated, by}`), templates
- `PUT /api/reviews/:id` `{review, base, force}` — `base` is the `updated` the
  page loaded; a different one gets 409 so two people don't overwrite each other
- `DELETE /api/reviews/:id`, `PUT /api/templates`
- `POST /api/import` — adds reviews/templates the database doesn't have; never overwrites
- `/api/users` (admin), `POST /api/me/pin`

## History

Until 2026-10-08 this was a GitHub Pages page that kept reviews in each
browser's localStorage (`mam_reviews_v2` etc.) and synced them to a Google
Sheet through an Apps Script (JSONP). The page still reads both, once:
- Account tab → "Copy from Google Sheet" (admins) pulls everything from the
  Apps Script (`OLD_SHEET_URL`), read-only.
- On sign-in, reviews in this browser's old localStorage that the database
  doesn't have are offered for upload. The old keys are left in place.

## Running locally

`npx --yes wrangler@4 dev --port 8103 --ip 127.0.0.1` from this folder
(configured in `.claude/launch.json`), then open http://127.0.0.1:8103/.
A fresh local database asks you to set up the first admin.

## Working rules

- Deploying (`npx wrangler deploy`) needs Erich's go-ahead.
- `index.html` is large — search for the relevant section and make focused
  edits rather than rewriting the file.
- Verify UI changes in the browser preview, including a phone-width
  layout, and check the console for errors.
- The shape of a review object is what's stored in the database (as JSON) and
  in old backups — call out any change to it.

## Light / dark toggle (2026-10-08)

Sun/moon button at the top right of the sidebar (shared spec
`Code/.claude/theme-spec.md`). The choice is saved in the cookie `aus-theme`
(`Domain=.austrussapps.com` on the live site, so it carries across the
Austruss apps) plus localStorage `aus-theme`; a tiny script at the top of
`<head>` applies it before the page draws. Nothing saved = follow the
computer. The existing `:root` tokens get dark values (under `@media screen`);
the sidebar stays dark in both. The PDF and Word exports build their own
pages with fixed colours and are untouched. The YAM plugin engine still has a
literal `#FAC775` card border (left alone: "do not edit below this line").
New styles must use the variables, not fixed colours.
