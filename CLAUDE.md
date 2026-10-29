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
- `POST /api/team` (anyone), `PATCH|DELETE /api/team/:id`, `POST /api/team/merge` (admins)

## Team list (2026-10-29)

Designer and Lead reviewer are `<select>`s filled from the `team` table
(`fillPersonSelect()`), so a person is added once (Team page, or "+ Add team
member…" in the box) and can't be mistyped. Reviews still store the name as a
plain string — no change to the review shape. Account tab → Team members
opens the page: anyone can add; admins rename (renames the name on every
review), hide, remove (only if unused) and "Tidy up names", which lists every
spelling on reviews that isn't a team member, suggests who it is
(`suggestPerson()`), and on Apply calls `POST /api/team/merge {from, to}` per
person. Merges and renames save the touched reviews as changed by the admin,
so a copy open elsewhere gets the usual 409 check.

## Excel export

`exportExcel()` (top bar) = the open review as one printable sheet;
`exportAllExcel()` (sidebar) = a Summary sheet (one row per review, filters,
"Open →" links) plus one sheet per review. Built in the browser with ExcelJS
4.4.0, loaded from cdnjs on first use. Internal notes are left out, like the
PDF and Word exports. Excel doesn't size merged wrapped rows, so `fitRow()`
estimates row heights from the text.

## Reports page (2026-10-29)

Sidebar "Reports — payouts · PDFs · recognition" opens a page in the main
area (`showReportsPage()`) with a month range (chips for this/last month,
quarter, year, all time, or From/To pickers). A review counts in the month of
its Period, else its date (`monthKey()`). Three exports:
- **QAM bonus payouts** (`exportPayoutPDF()` / `exportPayoutExcel()`) — every
  QAM/YAM in the range: scores, agreed payout, sign-off lines for the approver
  and accounts. Agreed payout is free text; a dollar figure in it is pulled out
  (`payoutAmount()`) and totalled. QAMs with no designer and no payout are left off.
- **All reviews as one PDF** (`exportReviewsPDF()`) — a contents page, then each
  review on its own page (`pdfReviewBody()`, the same HTML as the ↓ PDF button).
- **Recognition** (`exportRecognitionPDF()` / `exportRecognitionExcel()`) —
  grouped by the person recognised. Typed names join a team member when
  `suggestPerson()` finds one clear match ("Nat" → Nathaniel Newcombe); unclear
  ones keep their own group.

PDFs open a print window (`printDoc()`, shared CSS `PDF_CSS`); "Save as PDF" there.

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
