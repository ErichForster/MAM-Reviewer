// Austruss MAM / QAM reviews — Cloudflare Worker.
//   /          the review page (public/index.html)
//   /api/*     everything else → the Reviews Durable Object below, which holds
//              the reviewers (4-digit PINs), every review and the templates in
//              its SQLite storage. Replaced the Google Sheet + Apps Script sync
//              and GitHub Pages hosting (2026-10-08).
import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return env.REVIEWS.get(env.REVIEWS.idFromName("reviews")).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

const MIN = 60000;
const DAY = 24 * 60 * MIN;
const SESSION_MS = 30 * DAY;        // sliding: renewed while the app is in use
const MAX_REVIEW = 1024 * 1024;     // one review's JSON; they're a few KB in practice

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
  salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER, last_login INTEGER, disabled INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_fails (name TEXT PRIMARY KEY, n INTEGER, locks INTEGER, until INTEGER, last INTEGER);
CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, data TEXT NOT NULL, created INTEGER, created_by TEXT,
  updated INTEGER, updated_by TEXT);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS activity (at INTEGER, who TEXT, what TEXT);
CREATE TABLE IF NOT EXISTS team (id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER DEFAULT 1,
  created INTEGER, created_by TEXT);
`;

class Oops extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new Oops(status, message); };
const json = (data, status = 200, headers = {}) =>
  Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const parse = (s, dflt) => { try { return JSON.parse(s); } catch { return dflt; } };

function rid(n = 10) {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => a[b % a.length]).join("");
}
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  return hex(bits);
}
function checkPin(pin) {
  const p = String(pin ?? "");
  if (!/^\d{4}$/.test(p)) fail(400, "The PIN has to be 4 digits.");
  return p;
}
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
// Names are compared the way people mistype them: case and extra spaces don't count.
const norm = (v) => String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const memberName = (v) => {
  const name = str(v, 60).replace(/\s+/g, " ");
  if (name.length < 2) fail(400, "Give the team member a name.");
  return name;
};

// Review ids are whatever the page made (Date.now() numbers, or strings from
// the old Sheet), so they're compared as text.
const reviewId = (v) => {
  const id = str(v, 64);
  if (!id) fail(400, "That review has no id.");
  return id;
};

export class Reviews extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  all(q, ...a) { return this.sql.exec(q, ...a).toArray(); }
  one(q, ...a) { return this.all(q, ...a)[0] || null; }
  run(q, ...a) { this.sql.exec(q, ...a); }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname, method = request.method;
    try {
      const body = ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? await this.readBody(request) : {};
      if (path === "/api/me" && method === "GET") {
        const user = await this.userFrom(request);
        return json({ user: user && this.publicUser(user), setup: !this.one("SELECT id FROM users LIMIT 1") });
      }
      if (path === "/api/setup" && method === "POST") return await this.setup(body, url);
      if (path === "/api/login" && method === "POST") return await this.login(body, url);
      if (path === "/api/logout" && method === "POST") return await this.logout(request, url);

      const user = await this.userFrom(request);
      if (!user) return json({ error: "Please sign in." }, 401);
      const parts = path.slice(5).split("/").filter(Boolean).map(decodeURIComponent);
      const out = await this.route(user, method, parts, body || {});
      return out instanceof Response ? out : json(out ?? { ok: true });
    } catch (e) {
      if (e instanceof Oops) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: `Something went wrong: ${e.message}` }, 500);
    }
  }

  async readBody(request) {
    const text = await request.text();
    if (text.length > 20 * MAX_REVIEW) fail(413, "That's too much to send in one go.");
    return text ? parse(text, {}) : {};
  }

  async route(user, method, [what, id, sub], body) {
    const admin = () => user.role === "admin" || fail(403, "Only an admin can do that.");

    if (what === "data" && method === "GET") return this.data();

    // The team list: the only names the Designer and Lead reviewer boxes offer.
    // Anyone can add a person; renaming, hiding and merging are for admins.
    if (what === "team" && !id && method === "POST") {
      const name = this.checkMember(body.name);
      this.run("INSERT INTO team (id, name, active, created, created_by) VALUES (?, ?, 1, ?, ?)", rid(), name, Date.now(), user.name);
      this.log(user, `added ${name} to the team list`);
      return { team: this.team() };
    }
    if (what === "team" && id === "merge" && method === "POST") { admin(); return this.merge(user, body); }
    if (what === "team" && id && method === "PATCH") {
      admin();
      const m = this.one("SELECT * FROM team WHERE id = ?", id) || fail(404, "That team member was removed.");
      let renamed = 0;
      if (body.name !== undefined && memberName(body.name) !== m.name) {
        const name = this.checkMember(body.name, id);
        this.run("UPDATE team SET name = ? WHERE id = ?", name, id);
        renamed = this.renameInReviews(user, [m.name], name);
        this.log(user, `renamed ${m.name} to ${name} (${renamed} review(s) updated)`);
      }
      if (body.active !== undefined) {
        this.run("UPDATE team SET active = ? WHERE id = ?", body.active ? 1 : 0, id);
        this.log(user, `${body.active ? "showed" : "hid"} ${m.name} in the team list`);
      }
      return { team: this.team(), renamed };
    }
    if (what === "team" && id && method === "DELETE") {
      admin();
      const m = this.one("SELECT * FROM team WHERE id = ?", id) || fail(404, "That team member was removed.");
      const used = this.all("SELECT data FROM reviews").map((r) => parse(r.data, {}))
        .filter((r) => norm(r.designer) === norm(m.name) || norm(r.reviewer) === norm(m.name)).length;
      if (used) fail(400, `${m.name} is on ${used} review(s). Hide them instead, or merge them into someone else.`);
      this.run("DELETE FROM team WHERE id = ?", id);
      this.log(user, `removed ${m.name} from the team list`);
      return { team: this.team() };
    }

    if (what === "reviews" && id && method === "PUT") return this.putReview(user, reviewId(id), body);
    if (what === "reviews" && id && method === "DELETE") {
      const rid_ = reviewId(id);
      const row = this.one("SELECT data FROM reviews WHERE id = ?", rid_);
      if (row) {
        this.run("DELETE FROM reviews WHERE id = ?", rid_);
        this.log(user, `deleted ${this.label(parse(row.data, {}))}`);
      }
      return { ok: true };
    }

    if (what === "templates" && method === "PUT") {
      const t = {
        auditTemplates: Array.isArray(body.auditTemplates) ? body.auditTemplates : [],
        activeTemplateId: body.activeTemplateId || null,
        behavTemplates: Array.isArray(body.behavTemplates) ? body.behavTemplates : [],
        activeBehavTemplateId: body.activeBehavTemplateId || null,
      };
      const text = JSON.stringify(t);
      if (text.length > MAX_REVIEW) fail(413, "The templates are too big to save.");
      this.run("INSERT INTO meta (k, v) VALUES ('templates', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", text);
      this.run("INSERT INTO meta (k, v) VALUES ('templates_by', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        JSON.stringify({ at: Date.now(), by: user.name }));
      return { ok: true };
    }

    // Adds reviews and templates this database doesn't have yet; never
    // overwrites. Used for the one-off copy from the Google Sheet and for
    // reviews that only ever lived in one computer's browser.
    if (what === "import" && method === "POST") return this.import(user, body);

    if (what === "me" && id === "pin" && method === "POST") {
      const row = this.one("SELECT * FROM users WHERE id = ?", user.id);
      if (!sameText(await hashPin(String(body.current ?? ""), row.salt), row.hash)) fail(400, "Your current PIN isn't right.");
      await this.setPin(user.id, body.next);
      this.log(user, "changed their PIN");
      return { ok: true };
    }

    if (what === "users") {
      admin();
      if (!id && method === "GET") {
        return {
          users: this.all("SELECT * FROM users ORDER BY lower(name)").map((u) => ({
            ...this.publicUser(u), created: u.created, lastLogin: u.last_login, disabled: !!u.disabled,
          })),
          activity: this.all("SELECT * FROM activity ORDER BY at DESC LIMIT 60"),
        };
      }
      if (!id && method === "POST") {
        const name = this.checkName(body.name);
        checkPin(body.pin);
        const uid = rid();
        this.run("INSERT INTO users (id, name, role, salt, hash, created) VALUES (?, ?, ?, '', '', ?)",
          uid, name, body.role === "admin" ? "admin" : "reviewer", Date.now());
        await this.setPin(uid, body.pin);
        this.run("DELETE FROM login_fails WHERE name = lower(?)", name);
        this.log(user, `added ${name} as ${body.role === "admin" ? "an admin" : "a reviewer"}`);
        return { id: uid };
      }
      const u = this.one("SELECT * FROM users WHERE id = ?", id) || fail(404, "That person was removed.");
      const admins = () => this.one("SELECT count(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").n;
      if (method === "PATCH") {
        if (body.name !== undefined && str(body.name, 60) !== u.name) {
          this.run("UPDATE users SET name = ? WHERE id = ?", this.checkName(body.name, u.id), id);
        }
        if (body.role !== undefined) {
          const role = body.role === "admin" ? "admin" : "reviewer";
          if (u.role === "admin" && role !== "admin" && admins() <= 1) fail(400, "There has to be at least one admin.");
          this.run("UPDATE users SET role = ? WHERE id = ?", role, id);
        }
        if (body.disabled !== undefined) {
          if (body.disabled && u.id === user.id) fail(400, "You can't turn off your own sign-in.");
          if (body.disabled && u.role === "admin" && admins() <= 1) fail(400, "There has to be at least one admin.");
          this.run("UPDATE users SET disabled = ? WHERE id = ?", body.disabled ? 1 : 0, id);
          if (body.disabled) this.run("DELETE FROM sessions WHERE user_id = ?", id);
        }
        if (body.pin) {
          await this.setPin(id, body.pin);
          this.run("DELETE FROM login_fails WHERE name = lower(?)", u.name);
          this.run("DELETE FROM sessions WHERE user_id = ?", id);
        }
        this.log(user, `changed ${u.name}'s sign-in`);
        return { ok: true };
      }
      if (method === "DELETE") {
        if (u.id === user.id) fail(400, "You can't remove yourself.");
        if (u.role === "admin" && admins() <= 1) fail(400, "There has to be at least one admin.");
        this.run("DELETE FROM sessions WHERE user_id = ?", id);
        this.run("DELETE FROM users WHERE id = ?", id);
        this.log(user, `removed ${u.name}`);
        return { ok: true };
      }
    }

    fail(404, "Not found.");
  }

  // ── Reviews and templates ─────────────────

  data() {
    const rows = this.all("SELECT * FROM reviews ORDER BY created");
    const t = parse(this.one("SELECT v FROM meta WHERE k = 'templates'")?.v, null) || {};
    return {
      reviews: rows.map((r) => parse(r.data, null)).filter(Boolean),
      // Who saved each review last, and when; the page sends `updated` back as
      // `base` so two people saving the same review don't overwrite each other.
      saved: Object.fromEntries(rows.map((r) => [r.id, { updated: r.updated, by: r.updated_by }])),
      auditTemplates: t.auditTemplates || [],
      activeTemplateId: t.activeTemplateId || null,
      behavTemplates: t.behavTemplates || [],
      activeBehavTemplateId: t.activeBehavTemplateId || null,
      team: this.team(),
    };
  }

  team() {
    return this.all("SELECT id, name, active FROM team ORDER BY lower(name)").map((m) => ({ ...m, active: !!m.active }));
  }

  checkMember(v, selfId = "") {
    const name = memberName(v);
    const clash = this.all("SELECT id, name FROM team WHERE id != ?", selfId).find((m) => norm(m.name) === norm(name));
    if (clash) fail(400, `${clash.name} is already in the team list.`);
    return name;
  }

  // Every review whose Designer or Lead reviewer is one of `from` (or a
  // differently-spaced/cased `to`) gets `to` instead. Saved as a change by
  // `user`, so a copy someone has open gets the "saved by someone else" check.
  renameInReviews(user, from, to) {
    const olds = new Set([...from, to].map(norm));
    const now = Date.now();
    let n = 0;
    for (const row of this.all("SELECT id, data FROM reviews")) {
      const r = parse(row.data, null);
      if (!r) continue;
      let changed = false;
      for (const k of ["designer", "reviewer"]) {
        if (r[k] && olds.has(norm(r[k])) && r[k] !== to) { r[k] = to; changed = true; }
      }
      if (!changed) continue;
      this.run("UPDATE reviews SET data = ?, updated = ?, updated_by = ? WHERE id = ?", JSON.stringify(r), now, user.name, row.id);
      n++;
    }
    return n;
  }

  // Merge names used in reviews into one team member, adding them to the
  // team list if they aren't there yet.
  merge(user, body) {
    const to = memberName(body.to);
    const from = (Array.isArray(body.from) ? body.from : []).map((v) => String(v ?? "")).filter((v) => v.trim());
    if (!from.length) fail(400, "Pick the names to merge.");
    let m = this.all("SELECT * FROM team").find((x) => norm(x.name) === norm(to));
    if (!m) {
      this.run("INSERT INTO team (id, name, active, created, created_by) VALUES (?, ?, 1, ?, ?)", rid(), to, Date.now(), user.name);
    } else if (m.name !== to) {
      fail(400, `The team list spells it ${m.name}. Merge into that name.`);
    }
    // Team members whose name is being merged away go too.
    for (const x of this.all("SELECT * FROM team")) {
      if (norm(x.name) !== norm(to) && from.some((f) => norm(f) === norm(x.name))) this.run("DELETE FROM team WHERE id = ?", x.id);
    }
    const changed = this.renameInReviews(user, from, to);
    this.log(user, `merged ${from.map((f) => `“${f.trim()}”`).join(", ")} into ${to} (${changed} review(s) updated)`);
    return { team: this.team(), changed };
  }

  putReview(user, id, body) {
    const review = body.review;
    if (!review || typeof review !== "object" || Array.isArray(review)) fail(400, "Send the review.");
    if (String(review.id) !== id) fail(400, "The review's id doesn't match.");
    const text = JSON.stringify(review);
    if (text.length > MAX_REVIEW) fail(413, "That review is too big to save.");
    const row = this.one("SELECT * FROM reviews WHERE id = ?", id);
    const now = Date.now();
    if (row) {
      if (!body.force && (body.base ?? null) !== row.updated) {
        return json({
          error: `${row.updated_by || "Someone"} saved this review after you opened it.`,
          conflict: true, saved: { updated: row.updated, by: row.updated_by }, review: parse(row.data, null),
        }, 409);
      }
      this.run("UPDATE reviews SET data = ?, updated = ?, updated_by = ? WHERE id = ?", text, now, user.name, id);
      this.log(user, `saved ${this.label(review)}`);
    } else {
      this.run("INSERT INTO reviews (id, data, created, created_by, updated, updated_by) VALUES (?, ?, ?, ?, ?, ?)",
        id, text, now, user.name, now, user.name);
      this.log(user, `added ${this.label(review)}`);
    }
    return { saved: { updated: now, by: user.name } };
  }

  import(user, body) {
    const reviews = Array.isArray(body.reviews) ? body.reviews : [];
    const now = Date.now();
    let added = 0, skipped = 0;
    for (const r of reviews) {
      if (!r || typeof r !== "object" || r.id === undefined || r.id === null || r.id === "") { skipped++; continue; }
      const id = str(r.id, 64);
      const text = JSON.stringify(r);
      if (text.length > MAX_REVIEW || this.one("SELECT id FROM reviews WHERE id = ?", id)) { skipped++; continue; }
      this.run("INSERT INTO reviews (id, data, created, created_by, updated, updated_by) VALUES (?, ?, ?, ?, ?, ?)",
        id, text, now, user.name, now, user.name);
      added++;
    }

    const t = parse(this.one("SELECT v FROM meta WHERE k = 'templates'")?.v, null) || {
      auditTemplates: [], activeTemplateId: null, behavTemplates: [], activeBehavTemplateId: null,
    };
    let templatesAdded = 0;
    for (const [key, active] of [["auditTemplates", "activeTemplateId"], ["behavTemplates", "activeBehavTemplateId"]]) {
      for (const x of Array.isArray(body[key]) ? body[key] : []) {
        if (!x || !x.id || t[key].some((y) => y.id === x.id)) continue;
        t[key].push(x);
        templatesAdded++;
      }
      if (!t[active] && body[active] && t[key].some((y) => y.id === body[active])) t[active] = body[active];
    }
    if (templatesAdded) {
      this.run("INSERT INTO meta (k, v) VALUES ('templates', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(t));
    }
    const from = str(body.source, 60) || "a backup";
    if (added || templatesAdded) this.log(user, `copied in ${added} review(s) and ${templatesAdded} template(s) from ${from}`);
    return { added, skipped, templatesAdded };
  }

  label(r) {
    return `${r.designer || "someone"}'s ${r.period || "review"}`;
  }

  log(user, what) {
    this.run("INSERT INTO activity (at, who, what) VALUES (?, ?, ?)", Date.now(), user.name, what);
    this.run("DELETE FROM activity WHERE at < ?", Date.now() - 365 * DAY);
  }

  // ── Sign-in (the same 4-digit PIN scheme as the Austruss Hub) ─────────────────

  publicUser(u) { return { id: u.id, name: u.name, role: u.role }; }

  checkName(v, selfId = "") {
    const name = str(v, 60);
    if (name.length < 2) fail(400, "Give the person a name.");
    const clash = this.one("SELECT id FROM users WHERE lower(name) = lower(?) AND id != ?", name, selfId);
    if (clash) fail(400, `There's already someone called ${name}.`);
    return name;
  }

  async setPin(uid, pin) {
    const p = checkPin(pin);
    const salt = rid(16);
    this.run("UPDATE users SET salt = ?, hash = ? WHERE id = ?", salt, await hashPin(p, salt), uid);
  }

  cookie(url, token, maxAge) {
    const secure = url.protocol === "https:" ? "; Secure" : "";
    return `mam_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  }

  async startSession(uid, url) {
    const token = rid(32);
    this.run("INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)", await sha256(token), uid, Date.now() + SESSION_MS);
    this.run("UPDATE users SET last_login = ? WHERE id = ?", Date.now(), uid);
    this.run("DELETE FROM sessions WHERE expires < ?", Date.now());
    return this.cookie(url, token, 400 * 24 * 3600);
  }

  async userFrom(request) {
    const m = /(?:^|;\s*)mam_session=([a-z0-9]+)/.exec(request.headers.get("cookie") || "");
    if (!m) return null;
    const token = await sha256(m[1]);
    const row = this.one(`SELECT u.*, s.expires FROM sessions s JOIN users u ON u.id = s.user_id
                          WHERE s.token = ? AND s.expires > ? AND u.disabled = 0`, token, Date.now());
    if (!row) return null;
    if (row.expires - Date.now() < SESSION_MS - DAY) {
      this.run("UPDATE sessions SET expires = ? WHERE token = ?", Date.now() + SESSION_MS, token);
    }
    return row;
  }

  // The first person to open a fresh database becomes its admin.
  async setup(body, url) {
    if (this.one("SELECT id FROM users LIMIT 1")) fail(400, "This is already set up. Sign in instead.");
    const name = this.checkName(body.name);
    checkPin(body.pin);
    const uid = rid();
    this.run("INSERT INTO users (id, name, role, salt, hash, created) VALUES (?, ?, 'admin', '', '', ?)", uid, name, Date.now());
    try { await this.setPin(uid, body.pin); } catch (e) { this.run("DELETE FROM users WHERE id = ?", uid); throw e; }
    this.log({ name }, "set up the review database");
    const user = this.one("SELECT * FROM users WHERE id = ?", uid);
    return json({ user: this.publicUser(user) }, 200, { "set-cookie": await this.startSession(uid, url) });
  }

  async login(body, url) {
    // A 4-digit PIN is only safe with a lock-out: 5 wrong tries locks the name
    // for 15 min, then 1 h, 4 h, 24 h. A day without wrong tries starts it over.
    const key = str(body.name, 60).toLowerCase();
    const now = Date.now();
    let f = this.one("SELECT * FROM login_fails WHERE name = ?", key);
    if (f && now - f.last > DAY && f.until < now) { this.run("DELETE FROM login_fails WHERE name = ?", key); f = null; }
    if (f && f.until > now) {
      const mins = Math.ceil((f.until - now) / MIN);
      fail(429, `Too many wrong PINs. Try again in ${mins < 90 ? `${mins} min` : `${Math.round(mins / 60)} hours`}, or ask an admin to set a new PIN.`);
    }
    const u = this.one("SELECT * FROM users WHERE lower(name) = ? AND disabled = 0", key);
    const ok = u && sameText(await hashPin(String(body.pin ?? ""), u.salt), u.hash);
    if (!ok) {
      let n = (f ? f.n : 0) + 1, locks = f ? f.locks : 0, until = 0;
      if (n >= 5) { until = now + [15, 60, 240, 1440][Math.min(locks, 3)] * MIN; locks++; n = 0; }
      this.run(`INSERT INTO login_fails (name, n, locks, until, last) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET n = excluded.n, locks = excluded.locks, until = excluded.until, last = excluded.last`,
        key, n, locks, until, now);
      fail(401, until ? "Wrong PIN. That name is now locked for 15 min or more." : "That name and PIN don't match.");
    }
    this.run("DELETE FROM login_fails WHERE name = ?", key);
    return json({ user: this.publicUser(u) }, 200, { "set-cookie": await this.startSession(u.id, url) });
  }

  async logout(request, url) {
    const m = /(?:^|;\s*)mam_session=([a-z0-9]+)/.exec(request.headers.get("cookie") || "");
    if (m) this.run("DELETE FROM sessions WHERE token = ?", await sha256(m[1]));
    return json({ ok: true }, 200, { "set-cookie": this.cookie(url, "", 0) });
  }
}
