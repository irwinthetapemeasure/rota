/*
 * Rota crew tablet card.
 *
 * Reads sensor.rota_today (today) and, for other days, calls the rota/schedule
 * websocket command — so you can flip backwards and forwards through the days
 * with the arrows by the date. Drives rota.mark_done / rota.approve / rota.undo.
 * Dayparts (configurable day sections) with a whole-day toggle, plus an
 * always-visible long-term section for weekly / monthly chores.
 *
 * Config:
 *   type: custom:rota-card
 *   entity: sensor.rota_today   # optional
 *   title: Rota                 # optional
 */
class RotaCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._entity = this._config.entity || "sensor.rota_today";
    this._subject = null;
    this._daypart = null;
    this._whole = false;
    this._offset = 0; // days from today
    this._remote = null; // fetched snapshot for a non-today date
    this._loading = false;
    this._pending = null; // a non-today action awaiting confirmation
    this._crediting = null; // {chore,date,part} showing its "who did it?" picker
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    // Only re-render when our own sensor changed (HA replaces the state object
    // on change), not on every unrelated entity update.
    if (!prev || (prev.states && prev.states[this._entity]) !== (hass.states && hass.states[this._entity])) {
      this._render();
    }
  }

  getCardSize() {
    return 10;
  }

  _baseToday() {
    const st = this._hass && this._hass.states[this._entity];
    return st ? st.attributes.date : null;
  }

  _targetDateStr() {
    const base = this._baseToday();
    if (!base) return null;
    const d = new Date(base + "T00:00:00");
    d.setDate(d.getDate() + this._offset);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  _active() {
    if (this._offset === 0) {
      const st = this._hass.states[this._entity];
      return st ? st.attributes : null;
    }
    return this._remote;
  }

  _go(delta) {
    if (delta === 0) {
      this._offset = 0;
    } else {
      this._offset += delta;
    }
    this._subject = null;
    this._daypart = null;
    this._remote = null;
    this._pending = null;
    if (this._offset === 0) {
      this._render();
    } else {
      this._fetch();
    }
  }

  _fetch() {
    const ds = this._targetDateStr();
    const conn = this._hass && this._hass.connection;
    if (!ds || !conn) {
      this._render();
      return;
    }
    this._loading = true;
    this._render();
    conn
      .sendMessagePromise({ type: "rota/schedule", date: ds })
      .then((res) => {
        this._remote = res;
        this._loading = false;
        this._render();
      })
      .catch(() => {
        this._loading = false;
        this._render();
      });
  }

  _svc(action, chore, dateIso, part, by) {
    const map = { done: "mark_done", approve: "approve", undo: "undo" };
    if (!map[action]) return;
    const data = { chore };
    if (dateIso) data.date = dateIso;
    if (part) data.part = part;
    if (by) data.by = by;
    const p = this._hass.callService("rota", map[action], data);
    if (this._offset !== 0 && p && p.then) p.then(() => this._fetch());
  }

  _subjects(items) {
    const seen = [];
    const add = (n) => { if (n && !seen.includes(n)) seen.push(n); };
    for (const c of items) {
      if (c.members && c.members.length) c.members.forEach(add);
      else add(c.assignee);
    }
    return seen;
  }

  _render() {
    try {
      this._renderSafe();
    } catch (e) {
      console.error("rota-card render error", e);
      if (this.shadowRoot) {
        const msg = String((e && e.stack) || e).replace(/[<&>]/g, "");
        this.shadowRoot.innerHTML = `<ha-card style="padding:16px"><div style="font-weight:600;margin-bottom:8px">Rota card error (v${CARD_VERSION})</div><pre style="white-space:pre-wrap;font-size:12px;line-height:1.4;color:#c0392b;margin:0">${msg}</pre></ha-card>`;
      }
    }
  }

  _renderSafe() {
    if (!this._hass) return;
    const root = this.shadowRoot;
    const isToday = this._offset === 0;
    const a = this._active();

    const dateStr = a ? a.date : this._targetDateStr();
    const bar = `<div class="bar">
      <div class="brand"><span class="logo">${BROOM}</span>${escapeHtml(this._config.title || "Rota")}</div>
      <div class="nav">
        <button class="arw" data-nav="-1" aria-label="Previous day">‹</button>
        <button class="date ${isToday ? "today" : "link"}" data-nav="0">
          <span class="dtop">${fmtWeekday(dateStr)}${isToday ? '<span class="todaytag">Today</span>' : ""}</span>
          <span class="dsub">${fmtMonthDay(dateStr)}</span>
        </button>
        <button class="arw" data-nav="1" aria-label="Next day">›</button>
      </div>
    </div>`;

    if (!a) {
      root.innerHTML = `<ha-card>${bar}<div class="empty">${this._loading ? "Loading…" : "No schedule."}</div></ha-card>${STYLE}`;
      this._delegate();
      return;
    }

    const day = a.day || [];
    const longterm = a.longterm || [];
    const dayparts = a.dayparts || [];
    const sectioned = !!a.sections && dayparts.length > 0;
    this._pointsOn = !!a.points_on;
    this._candidates = a.candidates || [];

    const bonus = a.bonus || [];
    const subjects = this._subjects([...day, ...longterm]);
    if (this._subject && !subjects.includes(this._subject)) this._subject = null;
    const mine = (c) => !this._subject || c.assignee === this._subject || (c.members && c.members.includes(this._subject));
    const dayF = day.filter(mine);
    const ltF = longterm.filter(mine);

    const pick = (s, label) => {
      const sel = (s || "All") === (this._subject || "All");
      return `<button class="pick ${sel ? "sel" : ""}" data-pick="${s === null ? "" : enc(s)}">${escapeHtml(label)}</button>`;
    };
    const picks = subjects.length
      ? `<div class="picks">${[pick(null, "All"), ...subjects.map((s) => pick(s, s))].join("")}</div>`
      : "";

    let dayHtml;
    if (!sectioned) {
      dayHtml = this._group(null, dayF);
    } else {
      const defaultDp = isToday ? a.current_daypart : dayparts[0] && dayparts[0].id;
      const cur = this._daypart || defaultDp;
      const tabs = dayparts
        .map((dp) => {
          const undone = dayF.filter((c) => c.daypart === dp.id && c.status !== "done").length;
          const sel = !this._whole && cur === dp.id;
          const now = isToday && dp.id === a.current_daypart ? '<span class="dot"></span>' : "";
          return `<button class="tab ${sel ? "sel" : ""}" data-dp="${enc(dp.id)}">${now}${escapeHtml(dp.name)}${undone ? `<span class="n">${undone}</span>` : ""}</button>`;
        })
        .join("");
      const wholeBtn = `<button class="tab ${this._whole ? "sel" : ""}" data-whole="1">Whole day</button>`;
      let body;
      if (this._whole) {
        body = dayparts.map((dp) => this._group(dp.name, dayF.filter((c) => c.daypart === dp.id))).join("");
        const anytime = dayF.filter((c) => !c.daypart);
        if (anytime.length) body += this._group("Any time", anytime);
      } else {
        body = this._group(null, dayF.filter((c) => c.daypart === cur));
        const anytime = dayF.filter((c) => !c.daypart);
        if (anytime.length) body += this._group("Any time", anytime);
      }
      dayHtml = `<div class="tabs">${tabs}${wholeBtn}</div>${body}`;
    }

    const ltHtml = ltF.length ? `<div class="sec">Long-term</div>${this._group(null, ltF, true)}` : "";
    const bonusHtml = bonus.length ? `<div class="sec">Bonus — up for grabs</div>${this._group(null, bonus)}` : "";
    const confirmHtml = this._pending ? this._confirmBanner(dateStr) : "";
    const ptsHtml = this._pointsStrip(a);

    root.innerHTML = `<ha-card>${bar}${ptsHtml}${confirmHtml}${picks}${dayHtml}${ltHtml}${bonusHtml}</ha-card>${STYLE}`;
    this._delegate();
  }

  _pointsStrip(a) {
    const pts = a.points || {};
    const subs = Object.keys(pts);
    if (!subs.length) return "";
    const rows = subs.map((s) => [s, pts[s]]).sort((x, y) => y[1] - x[1]);
    const since = a.points_since ? " · since " + fmtMonthDay(a.points_since) : "";
    const chips = rows
      .map(([s, v], i) => `<span class="pchip2 ${i === 0 ? "lead" : ""}">${i === 0 ? '<span class="crown">★</span>' : ""}${escapeHtml(s)}<b>${v}</b></span>`)
      .join("");
    return `<div class="pts"><span class="plabel">Points${since}</span><div class="pchips">${chips}</div></div>`;
  }

  _confirmBanner(dateStr) {
    const p = this._pending;
    const label = fmtDate(dateStr);
    const verb = p.act === "approve" ? "Approve" : "Mark done";
    const forWho = p.by ? ` — credit ${escapeHtml(p.by)}` : "";
    return `<div class="warnbar">
      <div class="wt"><b>This is ${escapeHtml(label)}, not today.</b><div>${verb} “${escapeHtml(p.name)}”${forWho} for ${escapeHtml(label)}?</div></div>
      <div class="wb"><button class="wcancel" data-confirm-no="1">Cancel</button><button class="wok" data-confirm-yes="1">Yes, ${verb.toLowerCase()}</button></div>
    </div>`;
  }

  _delegate() {
    if (this._delegated) return;
    this.shadowRoot.addEventListener("click", (e) => this._onClick(e));
    this._delegated = true;
  }

  _group(header, items, longTerm) {
    if (!items.length && header === null) return `<div class="empty">Nothing here.</div>`;
    if (!items.length) return "";
    const head = header ? `<div class="grp">${escapeHtml(header)}</div>` : "";
    return head + `<div class="grid">${items.map((c) => this._choreCard(c, longTerm)).join("")}</div>`;
  }

  _choreCard(c, longTerm) {
    const status = c.status || "todo";
    const pts = c.points ? ` · +${c.points}` : "";
    const who = c.members && c.members.length ? (c.assignee || "") + " · " + c.members.join(", ")
      : (c.bonus ? "Anyone" : (c.assignee || ""));
    const dueTxt = c.due_date ? "Due " + fmtDate(c.due_date) : c.due || "";
    const checks = new Set(c.checklist_done || []);
    const total = (c.checklist || []).length;
    const prog = total ? ` · ${checks.size}/${total}` : "";
    const meta = (longTerm || c.floating
      ? escapeHtml(who + (dueTxt ? " · " + dueTxt : ""))
      : escapeHtml(who + (c.require_approval ? " · needs a check" : ""))) + prog;
    const attrs = `data-chore="${enc(c.id)}" data-date="${enc(c.date || "")}" data-part="${enc(c.daypart || "")}"`;
    const crediting = this._crediting && this._crediting.chore === c.id
      && this._crediting.date === (c.date || "") && this._crediting.part === (c.daypart || "");
    const checklistHtml = total && status !== "done"
      ? `<div class="cklist">${c.checklist.map((label, i) => `<button class="ck ${checks.has(i) ? "on" : ""}" data-check="${i}" ${attrs}><span class="ckbox">${checks.has(i) ? "✓" : ""}</span><span>${escapeHtml(label)}</span></button>`).join("")}</div>`
      : "";
    // How completion credits points: a picker (steal / bonus) under All, else a
    // fixed subject (the filtered person, or the per-person "everyone" instance).
    // Under the All view, anyone can claim a chore they did — so ask "who did
    // it?". This covers person / people / crew / bonus AND each "everyone"
    // instance (so Joe can steal Travis's Make Bed). Pairs are the exception:
    // they credit their whole member list, so no single-doer picker.
    const needpick = this._pointsOn && this._subject === null && c.assign !== "pair";
    const defaultBy = this._subject ? this._subject : (c.everyone ? (c.assignee || "") : "");
    let btn, extra = "";
    if (status === "done") {
      const credit = c.done_by ? " · " + escapeHtml(c.done_by) : "";
      btn = `<div class="btn done">✓ ${c.require_approval ? "Checked" : "Done"}${credit}${pts}</div>`;
      extra = `<button class="undo" data-act="undo" ${attrs}>Undo</button>`;
    } else if (status === "pending") {
      const credit = c.done_by ? ` (${escapeHtml(c.done_by)})` : "";
      btn = `<div class="btn pending">Waiting for a lead to check${credit}</div>`;
      extra = `<button class="approve" data-act="approve" ${attrs}>Lead: approve</button>`;
    } else if (crediting) {
      const cands = [c.assignee, ...this._candidates.filter((x) => x !== c.assignee)].filter(Boolean);
      const chips = cands.map((n) => `<button class="doer" data-doer="${enc(n)}">${escapeHtml(n)}</button>`).join("");
      btn = `<div class="picker"><div class="pq">Who did it? — they get the ${c.points || 0} pts</div><div class="doers">${chips}</div><button class="pcancel" data-credit-cancel="1">Cancel</button></div>`;
    } else {
      const doneAttrs = needpick ? 'data-needpick="1"' : `data-by="${enc(defaultBy)}"`;
      btn = `<button class="btn ${status === "overdue" ? "over" : "todo"}" data-act="done" ${doneAttrs} ${attrs}>Mark done${c.bonus ? ` · +${c.points || 0}` : ""}</button>`;
    }
    return `<div class="chore ${status}${crediting ? " crediting" : ""}${c.bonus ? " bonus" : ""}"><div class="ch"><div class="nm">${escapeHtml(c.name)}</div><div class="meta">${meta}</div></div>${checklistHtml}${btn}${extra ? `<div class="extra">${extra}</div>` : ""}</div>`;
  }

  _onClick(e) {
    const nav = e.target.closest("[data-nav]");
    if (nav) { this._go(parseInt(nav.getAttribute("data-nav"), 10)); return; }
    const pick = e.target.closest("[data-pick]");
    if (pick) { this._subject = dec(pick.getAttribute("data-pick")) || null; this._render(); return; }
    const tab = e.target.closest("[data-dp]");
    if (tab) { this._whole = false; this._daypart = dec(tab.getAttribute("data-dp")); this._render(); return; }
    if (e.target.closest("[data-whole]")) { this._whole = true; this._render(); return; }
    if (e.target.closest("[data-confirm-yes]")) {
      const p = this._pending;
      this._pending = null;
      if (p) this._svc(p.act, p.chore, p.date, p.part, p.by);
      this._render();
      return;
    }
    if (e.target.closest("[data-confirm-no]")) { this._pending = null; this._render(); return; }
    // "Who did it?" picker (kiosk steal): a candidate was chosen.
    const doer = e.target.closest("[data-doer]");
    if (doer) {
      const cr = this._crediting;
      if (cr) this._finishDone(doer, cr.chore, cr.date, cr.part, dec(doer.getAttribute("data-doer")));
      return;
    }
    if (e.target.closest("[data-credit-cancel]")) { this._crediting = null; this._render(); return; }
    // Tick / untick a checklist sub-item (progress only).
    const check = e.target.closest("[data-check]");
    if (check) {
      const data = { chore: dec(check.getAttribute("data-chore")), index: parseInt(check.getAttribute("data-check"), 10) };
      const date = dec(check.getAttribute("data-date"));
      const part = dec(check.getAttribute("data-part"));
      if (date) data.date = date;
      if (part) data.part = part;
      const p = this._hass.callService("rota", "toggle_check", data);
      if (this._offset !== 0 && p && p.then) p.then(() => this._fetch());
      return;
    }
    const act = e.target.closest("[data-act]");
    if (act) {
      const action = act.getAttribute("data-act");
      const chore = dec(act.getAttribute("data-chore"));
      const date = dec(act.getAttribute("data-date"));
      const part = dec(act.getAttribute("data-part"));
      if (action === "done") {
        // Some completions ask "who did it?" (steal / bonus under the All view);
        // others credit a fixed subject (the filtered person, or the per-person
        // "everyone" instance, or a pair's members).
        if (act.getAttribute("data-needpick")) {
          this._crediting = { chore, date, part };
          this._render();
          return;
        }
        this._finishDone(act, chore, date, part, dec(act.getAttribute("data-by") || "") || null);
        return;
      }
      // Guard approve on a day that isn't today.
      if (this._offset !== 0 && action === "approve") {
        const cell = act.closest(".chore");
        const name = cell ? cell.querySelector(".nm").textContent : chore;
        this._pending = { act: action, chore, date, part, name };
        this._render();
        return;
      }
      this._svc(action, chore, date, part);
    }
  }

  _finishDone(el, chore, date, part, by) {
    // Guard against absent-mindedly checking things off on a day that isn't today.
    if (this._offset !== 0) {
      const cell = el.closest(".chore");
      const name = cell ? cell.querySelector(".nm").textContent : chore;
      this._crediting = null;
      this._pending = { act: "done", chore, date, part, by, name };
      this._render();
      return;
    }
    this._crediting = null;
    this._svc("done", chore, date, part, by);
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
const enc = (s) => encodeURIComponent(String(s == null ? "" : s));
const dec = (s) => decodeURIComponent(String(s || ""));
function fmtDate(iso) {
  if (!iso) return "";
  try { return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); }
  catch (e) { return iso; }
}
function fmtWeekday(iso) {
  if (!iso) return "";
  try { return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "long" }); }
  catch (e) { return iso; }
}
function fmtMonthDay(iso) {
  if (!iso) return "";
  try { return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric" }); }
  catch (e) { return iso; }
}
const BROOM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.4 4.6 14 10M9.5 8.5l6 6M11 13l-6.5 6.5a1.5 1.5 0 0 1-2-.2M4 16s2 0 3.5 1.5S9 21 9 21M8 12l4 4"/></svg>';

const STYLE = `<style>
  ha-card { padding: 0 0 16px; overflow:hidden; }
  .bar { display:flex; align-items:center; gap:12px; padding: 16px 18px 14px; flex-wrap:wrap;
         border-bottom:1px solid var(--divider-color); }
  .brand { display:flex; align-items:center; gap:9px; flex:1; min-width:120px;
           font-size:15px; font-weight:600; letter-spacing:.12em; text-transform:uppercase; color: var(--primary-text-color); }
  .logo { display:grid; place-items:center; width:34px; height:34px; border-radius:10px;
          background: var(--primary-color); color: var(--text-primary-color,#fff); }
  .logo svg { width:19px; height:19px; }
  .nav { display:flex; align-items:center; gap:8px; }
  .arw { width:42px; height:42px; border-radius:12px; border:1px solid var(--divider-color); background: var(--card-background-color);
         color: var(--primary-text-color); font-size:22px; line-height:1; cursor:pointer; }
  .arw:hover { border-color: var(--primary-color); color: var(--primary-color); }
  .date { border:0; background:transparent; font:inherit; padding:4px 10px; min-width:150px; text-align:center; cursor:default;
          display:flex; flex-direction:column; align-items:center; gap:1px; border-radius:12px; }
  .date .dtop { font-size:18px; font-weight:600; color: var(--primary-text-color); display:flex; align-items:center; gap:8px; }
  .date .dsub { font-size:13px; color: var(--secondary-text-color); }
  .date.link { cursor:pointer; }
  .date.link:hover { background: var(--secondary-background-color); }
  .todaytag { font-size:10.5px; font-weight:700; letter-spacing:.04em; text-transform:uppercase;
              color: var(--primary-color); background: rgba(46,106,82,.14); padding:2px 8px; border-radius:20px; }
  .pts { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding: 12px 18px; background: var(--secondary-background-color); }
  .plabel { font-size:12px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color: var(--secondary-text-color); }
  .pchips { display:flex; gap:8px; flex-wrap:wrap; }
  .pchip2 { display:inline-flex; align-items:center; gap:7px; background: var(--card-background-color); border:1px solid var(--divider-color);
            border-radius:20px; padding:5px 12px; font-size:14px; color: var(--primary-text-color); }
  .pchip2 b { font-variant-numeric:tabular-nums; font-weight:700; color: var(--primary-color); }
  .pchip2.lead { border-color: var(--primary-color); }
  .crown { color: #E0A83E; font-size:13px; }
  .pad { padding: 16px; }
  .picks { display:flex; gap:8px; flex-wrap:wrap; padding: 4px 12px 8px; }
  .pick { border:1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color);
          border-radius: 12px; padding: 7px 14px; font: inherit; font-size: 14px; font-weight:500; cursor:pointer; }
  .pick.sel { border-color: var(--primary-color); box-shadow: 0 0 0 1px var(--primary-color) inset; color: var(--primary-color); }
  .tabs { display:flex; gap:8px; flex-wrap:wrap; padding: 4px 12px 10px; border-bottom:1px solid var(--divider-color); margin-bottom:10px; }
  .tab { border:1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color);
         border-radius: 12px; padding: 8px 13px; font: inherit; font-size: 15px; font-weight:500; cursor:pointer; display:flex; align-items:center; gap:7px; }
  .tab.sel { border-color: transparent; box-shadow: 0 0 0 2px var(--primary-color) inset; color: var(--primary-color); }
  .tab .n { background: var(--primary-color); color: var(--text-primary-color,#fff); border-radius: 20px; font-size:12px; font-weight:600; padding:0 7px; min-width:18px; text-align:center; }
  .tab .dot { width:7px; height:7px; border-radius:50%; background: var(--primary-color); }
  .grp { font-size:13px; font-weight:600; letter-spacing:.03em; text-transform:uppercase; color: var(--secondary-text-color); padding: 10px 14px 4px; }
  .sec { font-size:13px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; color: var(--secondary-text-color);
         padding: 16px 14px 4px; margin-top: 8px; border-top:1px solid var(--divider-color); }
  .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap:12px; padding: 4px 12px; }
  .chore { border:1px solid var(--divider-color); border-radius:16px; padding:16px; background: var(--card-background-color); }
  .ch { margin-bottom:14px; }
  .nm { font-size:17px; font-weight:500; color: var(--primary-text-color); }
  .meta { font-size:13px; color: var(--secondary-text-color); margin-top:2px; }
  .btn { width:100%; height:50px; border-radius:12px; border:0; font:inherit; font-size:16px; font-weight:500; cursor:pointer; display:flex; align-items:center; justify-content:center; }
  .btn.todo { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .btn.over { background: var(--error-color, #c0392b); color: #fff; }
  .btn.pending { background: rgba(180,130,20,.16); color: var(--warning-color, #b4791a); cursor:default; font-size:14px; }
  .btn.done { background: rgba(46,106,82,.16); color: var(--success-color, #2e6a52); cursor:default; }
  .chore.crediting { box-shadow: 0 0 0 2px var(--primary-color) inset; }
  .picker { display:flex; flex-direction:column; gap:10px; }
  .pq { font-size:13.5px; font-weight:500; color: var(--primary-text-color); text-align:center; }
  .doers { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; }
  .doer { min-height:44px; padding:0 16px; border-radius:12px; border:1px solid var(--primary-color); background: rgba(46,106,82,.08);
          color: var(--primary-color); font:inherit; font-size:15px; font-weight:600; cursor:pointer; }
  .doer:hover { background: var(--primary-color); color: var(--text-primary-color,#fff); }
  .pcancel { align-self:center; height:34px; padding:0 14px; border-radius:10px; border:1px solid var(--divider-color); background:transparent;
             color: var(--secondary-text-color); font:inherit; font-size:13px; cursor:pointer; }
  .cklist { display:flex; flex-direction:column; gap:6px; margin-bottom:14px; }
  .ck { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid var(--divider-color); border-radius:10px;
        background: var(--card-background-color); color: var(--primary-text-color); font:inherit; font-size:14px; text-align:left; cursor:pointer; }
  .ck .ckbox { width:20px; height:20px; border-radius:6px; border:1.5px solid var(--divider-color); display:grid; place-items:center;
               font-size:13px; font-weight:700; color: var(--text-primary-color,#fff); flex:none; }
  .ck.on { color: var(--secondary-text-color); }
  .ck.on .ckbox { background: var(--primary-color); border-color: var(--primary-color); }
  .ck.on span:last-child { text-decoration: line-through; }
  .chore.bonus { border-color: var(--warning-color, #b4791a); }
  .chore.bonus .nm::before { content:"★ "; color:#E0A83E; }
  .extra { margin-top:10px; display:flex; justify-content:center; }
  .approve { height:40px; padding:0 16px; border-radius:10px; border:1px solid var(--primary-color); background: transparent; color: var(--primary-color); font:inherit; font-weight:600; font-size:14px; cursor:pointer; }
  .undo { height:34px; padding:0 14px; border-radius:10px; border:1px solid var(--divider-color); background: transparent; color: var(--secondary-text-color); font:inherit; font-size:13px; cursor:pointer; }
  .empty { padding:20px; color: var(--secondary-text-color); font-style:italic; }
  .warnbar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin: 2px 12px 12px; padding: 12px 14px; border-radius: 12px;
             background: rgba(180,130,20,.14); border: 1px solid var(--warning-color, #b4791a); }
  .warnbar .wt { flex:1; min-width:180px; font-size:14px; color: var(--primary-text-color); }
  .warnbar .wt b { color: var(--warning-color, #b4791a); }
  .warnbar .wt div { color: var(--secondary-text-color); margin-top:2px; }
  .warnbar .wb { display:flex; gap:8px; }
  .wcancel { height:38px; padding:0 15px; border-radius:10px; border:1px solid var(--divider-color); background:transparent; color:var(--primary-text-color); font:inherit; font-weight:500; font-size:14px; cursor:pointer; }
  .wok { height:38px; padding:0 16px; border-radius:10px; border:0; background: var(--warning-color, #b4791a); color:#fff; font:inherit; font-weight:600; font-size:14px; cursor:pointer; }
</style>`;

const CARD_VERSION = "0.2.3";
if (!customElements.get("rota-card")) customElements.define("rota-card", RotaCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "rota-card", name: "Rota", description: "Rota crew tablet — day nav, dayparts, long-term chores, approvals." });
console.info(`%c ROTA-CARD %c v${CARD_VERSION} `, "color:#fff;background:#2e6a52", "color:#2e6a52;background:#eef1ee");
