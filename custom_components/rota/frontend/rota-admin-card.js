/*
 * Rota admin console (custom card).
 *
 * Talks to the rota websocket API (rota/state plus save/delete commands) to
 * manage volunteers, crews, chores, and settings. Stage A wires Volunteers +
 * Settings;
 * This week (crew board) and Chores come next.
 *
 *   type: custom:rota-admin-card
 */
class RotaAdminCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._view = "volunteers";
    this._state = null;
    this._search = "";
    this._confirmDel = null;
    this._confirmDelChore = null;
    this._sel = null; // crew-board selection (volunteer id)
    this._editing = null; // chore being edited (working copy) or null
    this._pointsData = null; // cached rota/points report
    this._pointsView = "weekly"; // weekly | monthly | annual
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    // Only load once. The admin card's data comes from the rota websocket
    // state, not hass entities — re-rendering on every hass update would nuke
    // whatever input the user is typing in.
    if (first) this._load();
  }

  getCardSize() {
    return 14;
  }

  _load() {
    if (!this._hass || !this._hass.connection) return;
    this._hass.connection
      .sendMessagePromise({ type: "rota/state" })
      .then((s) => { this._state = s; this._render(); })
      .catch(() => { this._err = true; this._render(); });
  }

  _cmd(type, payload) {
    return this._hass.connection
      .sendMessagePromise({ type, ...payload })
      .then((s) => { this._state = s; this._render(); return s; })
      .catch((e) => { console.error("rota admin", type, e); });
  }

  // ---- helpers ----
  _crewById(id) { return (this._state.crews || []).find((c) => c.id === id); }
  _effExp(v) { return v.experience === "new" && (v.weeks_active || 0) >= 2 ? "returning" : v.experience; }
  _avColor(v) { const c = v.crew_id && this._crewById(v.crew_id); return c ? c.color : "#8B948C"; }

  _weekdayIdxs(c) {
    const names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    return (c.days || []).map((d) => names.indexOf(String(d).toLowerCase().slice(0, 3))).filter((i) => i >= 0).sort((a, b) => a - b);
  }

  // The occurrence counter for an ordinal, mirroring engine.occurrence_index.
  _occIndex(c, ord) {
    const f = c.frequency || "daily";
    const interval = Math.max(parseInt(c.interval, 10) || 1, 1);
    const mode = ["daily", "every_n"].includes(f) ? "scheduled" : (c.mode || "floating");
    if (f === "weekly" && mode === "scheduled") {
      const idxs = this._weekdayIdxs(c);
      if (idxs.length) {
        const wd = ((ord - 1) % 7 + 7) % 7;
        const week = Math.floor((ord - wd) / 7);
        const pos = idxs.indexOf(wd);
        return week * idxs.length + (pos < 0 ? 0 : pos);
      }
    }
    if (f === "weekly") return Math.floor(ord / 7);
    if (f === "monthly") return this._state.today_ym || 0;
    if (f === "every_n") return Math.floor(ord / interval);
    return ord; // daily
  }

  _cycleIndexToday(c) { return this._occIndex(c, this._state.today_ordinal || 0); }

  // For a scheduled weekly people chore, show who lands on each due day this
  // week so the rotation is visible while editing.
  _weekPreview(c) {
    const people = c.people || [];
    const idxs = this._weekdayIdxs(c);
    const mode = c.mode || "floating";
    if (c.frequency !== "weekly" || mode !== "scheduled" || people.length < 2 || !idxs.length) return "";
    const ord = this._state.today_ordinal || 0;
    const monday = ord - ((ord - 1) % 7 + 7) % 7;
    const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const off = c.offset || 0, n = people.length;
    const parts = idxs.map((i) => {
      const idx = this._occIndex(c, monday + i) + off;
      return `<b>${names[i]}</b> ${escapeHtml(people[((idx % n) + n) % n])}`;
    });
    return `<div class="note">This week: ${parts.join(" · ")}</div>`;
  }

  // "Up today" picker for a people-rotation chore. Choosing a person sets the
  // chore's offset so they're assigned today; rotation continues by the calendar.
  _upTodayRow(c) {
    const people = c.people || [];
    if (people.length < 2) return "";
    const n = people.length;
    const idx = ((this._cycleIndexToday(c) + (c.offset || 0)) % n + n) % n;
    const cur = people[idx];
    const opts = people.map((nm) => `<option value="${enc(nm)}" ${nm === cur ? "selected" : ""}>${escapeHtml(nm)}</option>`).join("");
    return `<div class="frow"><span>Up today</span><select class="in sm" data-cupnow style="min-width:130px">${opts}</select><span style="font-size:12px">then rotates in order, by the calendar</span></div>`;
  }

  _render() {
    if (!this._hass) return;
    const root = this.shadowRoot;
    if (!this._state) {
      root.innerHTML = `<ha-card><div class="pad">${this._err ? "Couldn’t reach Rota." : "Loading…"}</div></ha-card>${STYLE}`;
      return;
    }
    const tabs = [["week", "This week"], ["chores", "Chores"], ["volunteers", "Volunteers"], ["points", "Points"], ["settings", "Settings"]]
      .map(([v, l]) => `<button class="tab ${this._view === v ? "sel" : ""}" data-view="${v}">${l}</button>`)
      .join("");
    let body = "";
    if (this._view === "volunteers") body = this._volunteers();
    else if (this._view === "settings") body = this._settings();
    else if (this._view === "week") body = this._week();
    else if (this._view === "points") body = this._pointsBody();
    else body = this._chores();

    root.innerHTML = `<ha-card>
      <div class="hd"><div class="brand">Rota admin</div><div class="tabs">${tabs}</div></div>
      ${body}
    </ha-card>${this._editing ? this._choreDrawer() : ""}${STYLE}`;
    this._delegate();
  }

  // ---- This week (crew board) ----
  _week() {
    const s = this._state.settings || {};
    const active = this._state.volunteers.filter((v) => v.active && !v.solo);
    const pool = active.filter((v) => !v.crew_id);
    const board = this._state.crews.map((c) => this._crewCard(c, active, s)).join("");
    const legend = s.experience
      ? `<div class="legend"><span class="ld"><i style="background:#2e6a52"></i>Lead</span><span class="ld"><i style="background:#4C7C9C"></i>Returning</span><span class="ld"><i style="background:#9A6810"></i>New</span><span class="hint" style="margin-left:auto">Experience is admin-only. Counts just help you decide.</span></div>`
      : "";
    return `<div class="quick"><span class="hint"><b>You</b> build the crews — drag a volunteer in, or click one then a crew. ${active.length} active, ${pool.length} unassigned.</span></div>
      <div class="pool" data-drop="pool"><div class="ph">Not yet assigned <b>${pool.length}</b></div>
        <div class="chips">${pool.length ? pool.map((v) => this._chip(v, true)).join("") : '<span class="hint" style="font-style:italic">Everyone’s placed.</span>'}</div></div>
      <div class="board">${board}<button class="addcrew" data-addcrew="1">+ Add crew</button></div>${legend}`;
  }

  _crewCard(c, active, s) {
    const m = active.filter((v) => v.crew_id === c.id);
    let mix;
    if (s.experience) {
      const n = (r) => m.filter((v) => this._effExp(v) === r).length;
      const parts = [];
      if (n("lead")) parts.push(`<span class="ld"><i style="background:#2e6a52"></i>${n("lead")} lead</span>`);
      if (n("returning")) parts.push(`<span class="ld"><i style="background:#4C7C9C"></i>${n("returning")} returning</span>`);
      if (n("new")) parts.push(`<span class="ld"><i style="background:#9A6810"></i>${n("new")} new</span>`);
      if (!n("lead") && m.length) parts.push('<span class="cwarn">no lead yet</span>');
      mix = m.length ? parts.join("") : "Empty — drop volunteers here";
    } else {
      mix = m.length ? `${m.length} on crew` : "Empty — drop volunteers here";
    }
    return `<div class="crew" data-drop="${c.id}"><div class="crewhd"><span class="cdot" style="background:${c.color}"></span><b>${escapeHtml(c.name)}</b><span class="cn">${m.length}</span><button class="rm" data-rmcrew="${c.id}" aria-label="Remove crew">${X}</button></div>
      <div class="cmix">${mix}</div><div class="crewbody">${m.map((v) => this._chip(v, false)).join("")}</div></div>`;
  }

  _chip(v, inPool) {
    const color = inPool ? "#8B948C" : this._avColor(v);
    const rdot = this._state.settings.experience ? `<span class="rdot" style="background:${expColor(this._effExp(v))}">${this._effExp(v)[0].toUpperCase()}</span>` : "";
    return `<span class="chip${this._sel === v.id ? " sel" : ""}" draggable="true" data-name="${v.id}"><span class="cav" style="background:${color}">${initials(v.name)}</span>${rdot}${escapeHtml(v.name)}${inPool ? "" : `<span class="cx" data-unassign="${v.id}">${X}</span>`}</span>`;
  }

  // ---- Chores ----
  _chores() {
    const s = this._state.settings || {};
    const rows = this._state.chores.map((c) => this._choreRow(c, s)).join("");
    return `<div class="quick"><button class="btn" data-addchore="1"><span>+</span> Add chore</button><span class="hint">${this._state.chores.length} chores.</span></div>
      <div class="clist">${this._state.chores.length ? rows : '<div class="vempty">No chores yet.</div>'}</div>`;
  }

  _choreRow(c, s) {
    if (this._confirmDelChore === c.id) {
      return `<div class="crow"><div class="cmeta"><b>${escapeHtml(c.name)}</b><div class="csub danger">Delete this chore?</div></div>
        <div class="cact"><button class="btn" data-cdelno="1">Cancel</button><button class="btn danger" data-cdelyes="${c.id}">Delete</button></div></div>`;
    }
    const badges = [];
    if (!["daily", "every_n"].includes(c.frequency || "daily")) badges.push(`<span class="cb">${(c.mode || "floating") === "scheduled" ? "Scheduled" : "Floating"}</span>`);
    if (s.points && c.points) badges.push(`<span class="cb">${c.points} pts</span>`);
    if (s.approvals && c.require_approval) badges.push(`<span class="cb ok">approval</span>`);
    if (c.dayparts && c.dayparts.length) badges.push(`<span class="cb">${c.dayparts.length}×/day</span>`);
    if (c.checklist && c.checklist.length) badges.push(`<span class="cb">${c.checklist.length}-item list</span>`);
    return `<div class="crow"><div class="cmeta" data-editchore="${c.id}"><b>${escapeHtml(c.name)}</b><div class="csub">${freqLabel(c)} · ${escapeHtml(assignLabel(c))} ${badges.join(" ")}</div></div>
      <div class="cact"><button class="rm" data-dupchore="${c.id}" aria-label="Duplicate">${COPY}</button>
      <button class="rm" data-delchore="${c.id}" aria-label="Delete">${TRASH}</button></div></div>`;
  }

  _choreDrawer() {
    const c = this._editing;
    const s = this._state.settings || {};
    const seg = (id, opts, val) => `<div class="seg" data-seg="${id}">${opts.map(([v, l]) => `<button data-segval="${v}" class="${val === v ? "on" : ""}">${l}</button>`).join("")}</div>`;
    const volNames = this._state.volunteers.map((v) => v.name);
    const dpSel = (s.dayparts || []).map((dp) => `<button class="pchip ${(c.dayparts || []).includes(dp.id) ? "on" : ""}" data-cdp="${dp.id}">${escapeHtml(dp.name)}</button>`).join("");
    const peopleSel = volNames.map((n) => `<button class="pchip ${(c.people || []).includes(n) ? "on" : ""}" data-cperson="${enc(n)}">${escapeHtml(n)}</button>`).join("");
    const isDayFreq = ["daily", "every_n"].includes(c.frequency || "daily");
    const mode = isDayFreq ? "scheduled" : (c.mode || "floating");
    const canType = ["weekly", "monthly"].includes(c.frequency);
    return `<div class="scrim" data-cancel="1"></div><div class="drawer">
      <div class="dhd"><b>${c.id ? "Edit chore" : "New chore"}</b><button class="rm" data-cancel="1">${X}</button></div>
      <div class="dbody">
        <label>Name</label><input id="ce-name" class="in" value="${escapeHtml(c.name || "")}" placeholder="e.g. Wash breakfast dishes" style="width:100%">
        <label>Schedule</label>${seg("freq", [["daily", "Daily"], ["every_n", "Every N days"], ["weekly", "Weekly"], ["monthly", "Monthly"]], c.frequency || "daily")}
        ${c.frequency === "every_n" ? `<div class="frow"><span>Every</span><input id="ce-interval" class="in sm" style="width:64px" value="${c.interval || 2}"><span>days</span></div>` : ""}
        ${canType ? `<label>Type</label>${seg("mode", [["scheduled", "Scheduled"], ["floating", "Floating"]], mode)}<div class="note">${mode === "scheduled" ? "Pinned to set days — appears in the daily list only on those days." : "Flexible timing — sits in Long-term until its due day, then drops into the daily list."}</div>` : ""}
        ${c.frequency === "weekly" && mode === "scheduled" ? `<label>On these days</label><div class="days">${["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => `<button class="pchip ${(c.days || []).includes(d) ? "on" : ""}" data-cday="${d}">${cap(d[0])}</button>`).join("")}</div>` : ""}
        ${c.frequency === "weekly" && mode === "floating" ? `<div class="note">Due by the end of each week (Sunday).</div>` : ""}
        ${c.frequency === "monthly" ? `<div class="frow"><span>${mode === "scheduled" ? "Runs on day" : "Due by day"}</span><input id="ce-dom" class="in sm" style="width:64px" value="${c.day_of_month || 1}"><span style="font-size:12px">of the month</span></div>` : ""}
        ${(s.dayparts || []).length && ["daily", "every_n", undefined].includes(c.frequency) ? `<label>Runs at (day sections)</label><div class="psel">${dpSel}</div><div class="note">Pick sections to repeat this chore through the day (e.g. dishes after each meal). Leave empty for once a day.${s.sections ? "" : " Turn on “Split the day into sections” in Settings to see the tabs on the tablet."}</div>` : ""}
        <label>Who does it</label>
        <select id="ce-assign" class="in" data-cassign style="width:100%">${[["person", "One person"], ["people", "Rotate people"], ["pair", "A pair (together)"], ["crew", "A crew"], ["everyone", "Everyone (each their own)"], ["bonus", "Bonus — up for grabs"]].map(([v, l]) => `<option value="${v}" ${(c.assign || "person") === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        ${c.assign === "crew" ? `<div class="note">Whole crew does it together; crews shuffle weekly.</div><div class="frow"><span>Rotation offset</span><input id="ce-offset" class="in sm" style="width:64px" value="${c.offset || 0}"><span style="font-size:12px">chores with the same offset move to the same crew each week</span></div>` : ""}
        ${c.assign === "people" ? `<div class="psel">${peopleSel}</div>${this._upTodayRow(c)}${this._weekPreview(c)}` : ""}
        ${c.assign === "pair" ? `<div class="note">These people do it together — everyone picked gets the points.</div><div class="psel">${peopleSel}</div>` : ""}
        ${c.assign === "person" ? `<select id="ce-person" class="in" style="width:100%">${volNames.map((n) => `<option ${c.person === n ? "selected" : ""}>${escapeHtml(n)}</option>`).join("")}</select>` : ""}
        ${c.assign === "everyone" ? `<div class="note">Every active person gets their own copy each day.</div>` : ""}
        ${c.assign === "bonus" ? `<div class="note">No fixed owner — anyone can claim it from the tablet for the points.</div>` : ""}
        <label>Checklist (optional)</label>
        <div class="cked">${(c.checklist || []).map((it, i) => `<div class="ckrow"><input class="in sm" data-ckitem="${i}" value="${escapeHtml(it)}" placeholder="Sub-task" style="flex:1"><button class="rm" data-ckdel="${i}" aria-label="Remove">${TRASH}</button></div>`).join("")}<button class="btn" data-ckadd="1" style="margin-top:6px"><span>+</span> Add item</button></div>
        <div class="note">Sub-tasks shown (and tickable) on the tablet — great for zone chores like a bathroom clean.</div>
        ${s.points ? `<label>Points</label><input id="ce-points" class="in sm" style="width:80px" value="${c.points || 0}">` : ""}
        ${s.approvals ? `<div class="drow"><div><b>Require approval</b><div class="sub">A lead checks before it counts.</div></div><button class="sw ${c.require_approval ? "on" : ""}" data-capprove="1"></button></div>` : ""}
      </div>
      <div class="dft">${c.id ? `<button class="btn danger" data-delchore="${c.id}">Delete</button>` : "<span></span>"}<div style="flex:1"></div><button class="btn" data-cancel="1">Cancel</button><button class="btn primary" data-savechore="1">Save chore</button></div>
    </div>`;
  }

  _syncEditor() {
    const c = this._editing;
    if (!c) return;
    const sr = this.shadowRoot;
    const g = (id) => { const el = sr.getElementById(id); return el ? el.value : undefined; };
    let x;
    if ((x = g("ce-name")) !== undefined) c.name = x;
    if ((x = g("ce-interval")) !== undefined) c.interval = parseInt(x, 10) || 1;
    if ((x = g("ce-points")) !== undefined) c.points = parseInt(x, 10) || 0;
    if ((x = g("ce-dom")) !== undefined) c.day_of_month = parseInt(x, 10) || 1;
    if ((x = g("ce-offset")) !== undefined) c.offset = parseInt(x, 10) || 0;
    if ((x = g("ce-person")) !== undefined) c.person = x;
    const items = [...sr.querySelectorAll("[data-ckitem]")];
    if (items.length) c.checklist = items.map((el) => el.value);
  }

  _delegate() {
    if (this._delegated) return;
    const sr = this.shadowRoot;
    sr.addEventListener("click", (e) => this._onClick(e));
    sr.addEventListener("change", (e) => this._onChange(e));
    sr.addEventListener("keydown", (e) => this._onKey(e));
    sr.addEventListener("dragstart", (e) => { const c = e.target.closest("[data-name]"); if (c) e.dataTransfer.setData("text", c.getAttribute("data-name")); });
    sr.addEventListener("dragover", (e) => { if (e.target.closest("[data-drop]")) e.preventDefault(); });
    sr.addEventListener("drop", (e) => {
      const z = e.target.closest("[data-drop]");
      if (!z) return;
      e.preventDefault();
      const id = e.dataTransfer.getData("text");
      if (id) { const dz = z.getAttribute("data-drop"); this._cmd("rota/assign", { volunteer_id: id, crew_id: dz === "pool" ? null : dz }); this._sel = null; }
    });
    this._delegated = true;
  }

  // ---- Volunteers ----
  _volunteers() {
    const s = this._state.settings || {};
    const q = this._search.toLowerCase();
    const match = (v) => v.name.toLowerCase().includes(q);
    const active = this._state.volunteers.filter((v) => v.active && match(v));
    const roster = this._state.volunteers.filter((v) => !v.active && match(v));
    const sec = (label, list, emptyMsg) =>
      `<div class="vsec">${label} <span class="c">${list.length}</span></div>
       <div class="vlist">${list.length ? list.map((v) => this._vrow(v, s)).join("") : `<div class="vempty">${emptyMsg}</div>`}</div>`;
    return `
      <div class="quick">
        <input id="vsearch" class="in" placeholder="Search staff by name" value="${escapeHtml(this._search)}" style="max-width:300px">
        <button class="btn" data-addvol="1"><span>+</span> Add volunteer</button>
        <span class="hint">Activate to move to This week. ${s.solo ? "Mark <b>Solo</b> to skip crews (household)." : ""} ${s.experience ? "<b>New</b> → <b>Returning</b> after 2 weeks." : ""}</span>
      </div>
      ${sec("Active this week", active, q ? "No active staff match." : "No active staff yet.")}
      ${sec("Roster", roster, q ? "No inactive staff match." : "Everyone is active.")}`;
  }

  _vrow(v, s) {
    if (this._confirmDel === v.id) {
      return `<div class="vrow"><span class="av" style="background:#8B948C">${initials(v.name)}</span>
        <div class="vmeta"><b>${escapeHtml(v.name)}</b></div>
        <div class="vact"><span class="danger">Delete ${escapeHtml(v.name)}?</span>
          <button class="btn" data-delno="1">Cancel</button>
          <button class="btn danger" data-delyes="${v.id}">Delete</button></div></div>`;
    }
    const exp = s.experience
      ? `<div class="er"><select class="in sm" data-vexp="${v.id}">
          ${["lead", "returning", "new"].map((r) => `<option value="${r}" ${v.experience === r ? "selected" : ""}>${cap(r)}</option>`).join("")}
        </select><span>· ${v.weeks_active || 0} wks</span>${v.experience === "new" && (v.weeks_active || 0) >= 2 ? '<span class="promo">auto → Returning</span>' : ""}</div>`
      : "";
    const soloBadge = s.solo && v.solo ? '<span class="solobadge">Solo</span>' : "";
    const soloBtn = s.solo ? `<button class="mini ${v.solo ? "on" : ""}" data-vsolo="${v.id}">Solo</button>` : "";
    let notifyRow = "";
    if (s.notifications) {
      const svc = Object.keys((this._hass && this._hass.services && this._hass.services.notify) || {});
      notifyRow = `<div class="er"><span>Device</span><select class="in sm" data-vnotify="${v.id}"><option value="">— none —</option>${svc.map((n) => `<option value="${n}" ${v.notify === n ? "selected" : ""}>${escapeHtml(n)}</option>`).join("")}</select></div>`;
    }
    return `<div class="vrow"><span class="av" style="background:${this._avColor(v)}">${initials(v.name)}</span>
      <div class="vmeta"><b>${escapeHtml(v.name)} ${soloBadge}</b>${exp}${notifyRow}</div>
      <div class="vact">${soloBtn}
        <button class="sw ${v.active ? "on" : ""}" data-vactive="${v.id}" role="switch" aria-checked="${v.active}"></button>
        <button class="rm" data-vdel="${v.id}" aria-label="Delete">${TRASH}</button></div></div>`;
  }

  // ---- Settings ----
  _settings() {
    const s = this._state.settings || {};
    const toggles = [
      ["notifications", "Reminders", "Nudge people on their phone about chores they haven’t finished. Turn off for camp. Set each person’s device on the Volunteers tab."],
      ["solo", "Solo users", "Assign chores to a person on their own — straight into the schedule, bypassing crews. On for a household."],
      ["approvals", "Approvals", "Allow chores that need a lead to check the work before it counts."],
      ["points", "Award points", "Track points for completed chores. Off = accountability only."],
      ["experience", "Experience levels", "Track Lead / Returning / New per volunteer; auto-promote after 2 weeks. Admin-only."],
      ["sections", "Split the day into sections", "Show dayparts on the tablet (meals, shifts). Configure the sections below."],
    ];
    const rows = toggles
      .map(([k, t, d]) => `<div class="setrow"><div class="st"><b>${t}</b><div>${d}</div></div>
        <button class="sw ${s[k] ? "on" : ""}" data-set="${k}" role="switch" aria-checked="${!!s[k]}"></button></div>`)
      .join("");
    const timeRow = s.notifications
      ? `<div class="setrow"><div class="st"><b>Reminder time</b><div>When the daily nudge goes out.</div></div><input class="in sm" data-rtime value="${escapeHtml(s.reminder_time || "20:00")}" placeholder="20:00" style="width:90px"></div>`
      : "";
    const dps = (s.dayparts || [])
      .map((dp, i) => `<div class="dprow">
        <input class="in sm" data-dpname="${i}" value="${escapeHtml(dp.name)}" style="flex:1">
        <input class="in sm" data-dpstart="${i}" value="${escapeHtml(dp.start || "")}" placeholder="07:00" style="width:88px">
        <button class="rm" data-dpdel="${i}" aria-label="Remove section">${TRASH}</button></div>`)
      .join("");
    return `<div class="setwrap">${rows}${timeRow}</div>
      <div class="vsec">Day sections <span class="c">${(s.dayparts || []).length}</span></div>
      <div class="dpwrap">${dps || '<div class="vempty">No sections.</div>'}
        <button class="btn" data-dpadd="1" style="margin-top:10px"><span>+</span> Add section</button></div>`;
  }

  // ---- Points ----
  _loadPoints() {
    if (!this._hass || !this._hass.connection) return;
    this._hass.connection
      .sendMessagePromise({ type: "rota/points" })
      .then((p) => { this._pointsData = p; if (this._view === "points") this._render(); })
      .catch((e) => console.error("rota points", e));
  }

  _subColor(name) {
    const crew = (this._state.crews || []).find((c) => c.name === name);
    if (crew && crew.color) return crew.color;
    const pal = ["#4C7C9C", "#7A9A3E", "#B07A2E", "#8A5A9C", "#C06B5A", "#3E9488", "#9A6810", "#2e6a52"];
    const subs = (this._pointsData && this._pointsData.subjects) || [];
    const i = subs.indexOf(name);
    return pal[(i < 0 ? 0 : i) % pal.length];
  }

  _pointsBody() {
    const p = this._pointsData;
    if (!p) return `<div class="pad">Loading points…</div>`;
    const resets = [["none", "Never"], ["weekly", "Weekly"], ["biweekly", "Every 2 weeks"], ["monthly", "Monthly"]];
    const cur = p.reset || "none";
    const resetSel = `<div class="frow"><span>Reset standings</span><select class="in sm" data-preset>${resets.map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${l}</option>`).join("")}</select>${p.since ? `<span class="hint">window since ${fmtDay(p.since)}</span>` : `<span class="hint">all-time</span>`}</div>`;
    const subjects = p.subjects || [];
    const viewTabs = [["weekly", "Weekly"], ["monthly", "Monthly"], ["annual", "Annual"]]
      .map(([v, l]) => `<button class="tab ${this._pointsView === v ? "sel" : ""}" data-pview="${v}">${l}</button>`).join("");
    return `<div class="quick" style="justify-content:space-between">${resetSel}<button class="btn" data-preload="1">Refresh</button></div>
      <div class="vsec">Current standings <span class="c">${p.since ? "this window" : "all-time"}</span></div>
      <div class="standwrap">${this._standings(p.current || {}, subjects)}</div>
      <div class="vsec">History</div>
      <div class="chartwrap"><div class="ptabs">${viewTabs}</div>${this._chart(p[this._pointsView] || [], subjects)}${this._legend(subjects)}</div>`;
  }

  _standings(totals, subjects) {
    const rows = subjects.map((s) => [s, totals[s] || 0]).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return `<div class="vempty">No points recorded yet.</div>`;
    const max = Math.max(1, rows[0][1]);
    return rows.map(([s, v], i) => `<div class="standrow"><span class="rank">${i + 1}</span>
      <span class="sname">${escapeHtml(s)}</span>
      <div class="sbar"><i style="width:${Math.round((v / max) * 100)}%;background:${this._subColor(s)}"></i></div>
      <b class="sval">${v}</b></div>`).join("");
  }

  _chart(series, subjects) {
    if (!series.length || !subjects.length) return `<div class="vempty">No history yet.</div>`;
    const H = 190, base = H - 22, top = 12;
    let max = 1;
    series.forEach((b) => subjects.forEach((s) => { max = Math.max(max, (b.totals || {})[s] || 0); }));
    const bw = subjects.length > 4 ? 8 : 13;
    const groupW = bw * subjects.length + (subjects.length - 1) * 2;
    const stepX = Math.max(groupW + 20, 46);
    const W = Math.max(series.length * stepX + 12, 300);
    let bars = "", labels = "";
    series.forEach((b, gi) => {
      const gx = 6 + gi * stepX + (stepX - groupW) / 2;
      subjects.forEach((s, si) => {
        const v = (b.totals || {})[s] || 0;
        const h = Math.round((v / max) * (base - top));
        const x = gx + si * (bw + 2), y = base - h;
        bars += `<rect x="${x.toFixed(1)}" y="${y}" width="${bw}" height="${Math.max(h, v ? 2 : 0)}" rx="2" fill="${this._subColor(s)}"><title>${escapeHtml(s)}: ${v}</title></rect>`;
      });
      labels += `<text x="${(gx + groupW / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle" class="axl">${escapeHtml(fmtBucket(b.start, this._pointsView))}</text>`;
    });
    return `<div class="chartscroll"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="chart"><line x1="6" y1="${base}" x2="${W - 6}" y2="${base}" class="axis"/>${bars}${labels}</svg></div>`;
  }

  _legend(subjects) {
    if (!subjects.length) return "";
    return `<div class="legend2">${subjects.map((s) => `<span class="ld"><i style="background:${this._subColor(s)}"></i>${escapeHtml(s)}</span>`).join("")}</div>`;
  }

  // ---- events ----
  _onClick(e) {
    const t = (a) => e.target.closest(`[${a}]`);
    let el;
    if ((el = t("data-view"))) { this._view = el.getAttribute("data-view"); this._confirmDel = null; this._confirmDelChore = null; if (this._view === "points") this._loadPoints(); this._render(); return; }
    if ((el = t("data-pview"))) { this._pointsView = el.getAttribute("data-pview"); this._render(); return; }
    if (t("data-preload")) { this._loadPoints(); return; }
    if ((el = t("data-vactive"))) { const v = this._vol(el.getAttribute("data-vactive")); this._cmd("rota/volunteer/save", { volunteer: { id: v.id, active: !v.active } }); return; }
    if ((el = t("data-vsolo"))) { const v = this._vol(el.getAttribute("data-vsolo")); this._cmd("rota/volunteer/save", { volunteer: { id: v.id, solo: !v.solo } }); return; }
    if ((el = t("data-vdel"))) { this._confirmDel = el.getAttribute("data-vdel"); this._render(); return; }
    if (t("data-delno")) { this._confirmDel = null; this._render(); return; }
    if ((el = t("data-delyes"))) { this._confirmDel = null; this._cmd("rota/volunteer/delete", { target: el.getAttribute("data-delyes") }); return; }
    if (t("data-addvol")) {
      const name = window.prompt("New volunteer name?");
      if (name && name.trim()) this._cmd("rota/volunteer/save", { volunteer: { name: name.trim(), active: true, experience: "new", weeks_active: 0 } });
      return;
    }
    if ((el = t("data-set"))) { const k = el.getAttribute("data-set"); this._cmd("rota/settings/save", { settings: { [k]: !this._state.settings[k] } }); return; }
    if (t("data-dpadd")) {
      const dayparts = [...(this._state.settings.dayparts || []), { id: "dp" + Date.now(), name: "New section", start: "12:00" }];
      this._cmd("rota/settings/save", { settings: { dayparts } });
      return;
    }
    if ((el = t("data-dpdel"))) {
      const i = +el.getAttribute("data-dpdel");
      const dayparts = (this._state.settings.dayparts || []).filter((_, j) => j !== i);
      this._cmd("rota/settings/save", { settings: { dayparts } });
      return;
    }
    // ---- This week ----
    if ((el = t("data-unassign"))) { this._cmd("rota/assign", { volunteer_id: el.getAttribute("data-unassign"), crew_id: null }); return; }
    if ((el = t("data-rmcrew"))) { this._cmd("rota/crew/delete", { target: el.getAttribute("data-rmcrew") }); return; }
    if (t("data-addcrew")) { this._addCrew(); return; }
    if ((el = t("data-name"))) { const id = el.getAttribute("data-name"); this._sel = this._sel === id ? null : id; this._render(); return; }
    if ((el = t("data-drop"))) { if (this._sel) { const dz = el.getAttribute("data-drop"); this._cmd("rota/assign", { volunteer_id: this._sel, crew_id: dz === "pool" ? null : dz }); this._sel = null; } return; }
    // ---- Chores ----
    if (t("data-addchore")) { this._editing = { assign: "person", frequency: "daily", points: 0, person: (this._state.volunteers[0] || {}).name, active: true }; this._render(); return; }
    if ((el = t("data-editchore"))) { const c = this._state.chores.find((x) => x.id === el.getAttribute("data-editchore")); if (c) { this._editing = JSON.parse(JSON.stringify(c)); this._render(); } return; }
    if ((el = t("data-delchore"))) { this._editing = null; this._confirmDelChore = el.getAttribute("data-delchore"); this._render(); return; }
    if (t("data-cdelno")) { this._confirmDelChore = null; this._render(); return; }
    if ((el = t("data-cdelyes"))) { const id = el.getAttribute("data-cdelyes"); this._confirmDelChore = null; this._cmd("rota/chore/delete", { target: id }); return; }
    if ((el = t("data-dupchore"))) { const src = this._state.chores.find((x) => x.id === el.getAttribute("data-dupchore")); if (src) { const copy = JSON.parse(JSON.stringify(src)); delete copy.id; copy.name = (src.name || "Chore") + " (copy)"; this._cmd("rota/chore/save", { chore: copy }); } return; }
    // ---- Chore editor ----
    if (t("data-cancel")) { this._editing = null; this._render(); return; }
    if (t("data-savechore")) { this._syncEditor(); const c = this._editing; c.checklist = (c.checklist || []).map((x) => x.trim()).filter(Boolean); this._editing = null; this._cmd("rota/chore/save", { chore: c }); return; }
    if ((el = t("data-segval"))) { this._syncEditor(); const seg = el.closest("[data-seg]").getAttribute("data-seg"); const field = { freq: "frequency", assign: "assign", mode: "mode" }[seg] || seg; this._editing[field] = el.getAttribute("data-segval"); this._render(); return; }
    if ((el = t("data-cdp"))) { this._syncEditor(); this._toggleArr("dayparts", el.getAttribute("data-cdp")); this._render(); return; }
    if ((el = t("data-cday"))) { this._syncEditor(); this._toggleArr("days", el.getAttribute("data-cday")); this._render(); return; }
    if ((el = t("data-cperson"))) { this._syncEditor(); this._toggleArr("people", dec(el.getAttribute("data-cperson"))); this._render(); return; }
    if (t("data-ckadd")) { this._syncEditor(); this._editing.checklist = [...(this._editing.checklist || []), ""]; this._render(); return; }
    if ((el = t("data-ckdel"))) { this._syncEditor(); const i = +el.getAttribute("data-ckdel"); this._editing.checklist = (this._editing.checklist || []).filter((_, j) => j !== i); this._render(); return; }
    if (t("data-capprove")) { this._syncEditor(); this._editing.require_approval = !this._editing.require_approval; this._render(); return; }
  }

  _addCrew() {
    const names = ["Otters", "Falcons", "Bears", "Herons", "Foxes", "Pines", "Loons", "Cedars"];
    const used = this._state.crews.map((c) => c.name);
    const nm = names.find((n) => !used.includes(n)) || "Crew " + (this._state.crews.length + 1);
    const palette = ["#4C7C9C", "#7A9A3E", "#B07A2E", "#8A5A9C", "#C06B5A", "#3E9488"];
    this._cmd("rota/crew/save", { crew: { name: nm, color: palette[this._state.crews.length % palette.length] } });
  }

  _toggleArr(key, val) {
    const arr = this._editing[key] || [];
    this._editing[key] = arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val];
  }

  _onChange(e) {
    const el = e.target;
    if (el.hasAttribute("data-cassign")) { this._syncEditor(); this._editing.assign = el.value; this._render(); return; }
    if (el.hasAttribute("data-cupnow")) {
      this._syncEditor();
      const c = this._editing, people = c.people || [], n = people.length;
      const p = people.indexOf(dec(el.value));
      if (p >= 0 && n) c.offset = (((p - this._cycleIndexToday(c)) % n) + n) % n;
      this._render();
      return;
    }
    if (el.hasAttribute("data-vexp")) { const v = this._vol(el.getAttribute("data-vexp")); this._cmd("rota/volunteer/save", { volunteer: { id: v.id, experience: el.value } }); return; }
    if (el.hasAttribute("data-vnotify")) { this._cmd("rota/volunteer/save", { volunteer: { id: el.getAttribute("data-vnotify"), notify: el.value || null } }); return; }
    if (el.hasAttribute("data-rtime")) { this._cmd("rota/settings/save", { settings: { reminder_time: el.value || "20:00" } }); return; }
    if (el.hasAttribute("data-preset")) { this._cmd("rota/settings/save", { settings: { points_reset: el.value } }).then(() => this._loadPoints()); return; }
    if (el.hasAttribute("data-dpname") || el.hasAttribute("data-dpstart")) {
      const dayparts = (this._state.settings.dayparts || []).map((dp) => ({ ...dp }));
      this.shadowRoot.querySelectorAll("[data-dpname]").forEach((n) => { dayparts[+n.getAttribute("data-dpname")].name = n.value; });
      this.shadowRoot.querySelectorAll("[data-dpstart]").forEach((n) => { dayparts[+n.getAttribute("data-dpstart")].start = n.value; });
      this._cmd("rota/settings/save", { settings: { dayparts } });
    }
  }

  _onKey(e) {
    if (e.target.id === "vsearch") {
      // live filter without losing focus: update state + re-filter the lists only
      setTimeout(() => { this._search = e.target.value; this._filterVols(); }, 0);
    }
  }

  _filterVols() {
    // lightweight: re-render just the volunteer lists, keep search focus
    if (this._view !== "volunteers") return;
    const root = this.shadowRoot;
    const input = root.getElementById("vsearch");
    const pos = input ? input.selectionStart : null;
    this._render();
    const ni = root.getElementById("vsearch");
    if (ni) { ni.focus(); if (pos != null) ni.setSelectionRange(pos, pos); }
  }

  _vol(id) { return this._state.volunteers.find((v) => v.id === id); }
}

function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
function initials(n) { return String(n || "").split(" ").map((x) => x[0]).join("").slice(0, 2).toUpperCase(); }
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
const TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>';
const COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const enc = (s) => encodeURIComponent(String(s == null ? "" : s));
const dec = (s) => decodeURIComponent(String(s || ""));
function expColor(e) { return { lead: "#2e6a52", returning: "#4C7C9C", new: "#9A6810" }[e] || "#8B948C"; }
function fmtDay(iso) { try { return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }); } catch (e) { return iso; } }
function fmtBucket(iso, view) {
  try {
    const d = new Date(iso + "T00:00:00");
    if (view === "annual") return String(d.getFullYear());
    if (view === "monthly") return d.toLocaleDateString(undefined, { month: "short" });
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch (e) { return iso; }
}
function freqLabel(c) {
  const f = c.frequency || "daily";
  if (f === "every_n") return `Every ${c.interval || 2} days`;
  if (f === "weekly") return "Weekly" + (c.days && c.days.length ? " · " + c.days.map((d) => cap(d)).join("/") : "");
  if (f === "monthly") return `Monthly · ${c.day_of_month || 1}`;
  return cap(f);
}
function assignLabel(c) {
  if (c.assign === "crew") return "Crew (rotates weekly)";
  if (c.assign === "people") return "Rotate: " + (c.people || []).join(", ");
  if (c.assign === "pair") return "Together: " + (c.people || []).join(" & ");
  if (c.assign === "everyone") return "Everyone";
  if (c.assign === "bonus") return "Bonus — up for grabs";
  return "Only " + (c.person || "—");
}

const STYLE = `<style>
  ha-card { padding: 0 0 16px; }
  .pad { padding: 20px; color: var(--secondary-text-color); }
  .hd { display:flex; align-items:center; gap:16px; padding: 14px 16px; border-bottom:1px solid var(--divider-color); flex-wrap:wrap; }
  .brand { font-weight:600; letter-spacing:.1em; text-transform:uppercase; font-size:14px; color: var(--primary-text-color); }
  .tabs { display:flex; gap:4px; background: var(--secondary-background-color); border-radius:9px; padding:3px; }
  .tab { border:0; background:none; font:inherit; font-size:14px; font-weight:500; color: var(--secondary-text-color); padding:6px 13px; border-radius:7px; cursor:pointer; }
  .tab.sel { background: var(--card-background-color); color: var(--primary-text-color); }
  .quick { display:flex; gap:10px; align-items:center; flex-wrap:wrap; padding: 14px 16px 8px; }
  .in { font:inherit; font-size:14px; height:38px; padding:0 12px; border:1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); border-radius:8px; }
  .in.sm { height:32px; font-size:13px; }
  .btn { display:inline-flex; align-items:center; gap:6px; height:38px; padding:0 14px; border-radius:8px; border:1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); font:inherit; font-weight:500; font-size:14px; cursor:pointer; }
  .btn span { font-size:17px; line-height:1; }
  .btn.danger { background: var(--error-color,#c0392b); border-color: var(--error-color,#c0392b); color:#fff; }
  .hint { font-size:12.5px; color: var(--secondary-text-color); }
  .vsec { font-size:12px; letter-spacing:.05em; text-transform:uppercase; color: var(--secondary-text-color); font-weight:600; padding: 16px 16px 8px; display:flex; align-items:center; gap:8px; }
  .vsec .c { background: var(--secondary-background-color); border-radius:20px; padding:1px 8px; }
  .vlist, .dpwrap, .setwrap { margin: 0 16px; border:1px solid var(--divider-color); border-radius:12px; overflow:hidden; }
  .dpwrap { padding: 12px; }
  .vempty { padding: 14px 16px; color: var(--secondary-text-color); font-style:italic; font-size:13.5px; }
  .vrow { display:flex; align-items:center; gap:12px; padding:10px 14px; border-top:1px solid var(--divider-color); }
  .vrow:first-child { border-top:0; }
  .av { width:38px; height:38px; border-radius:50%; display:grid; place-items:center; color:#fff; font-weight:600; font-size:13px; flex:none; }
  .vmeta { flex:1; min-width:0; }
  .vmeta b { font-weight:550; font-size:14.5px; display:flex; align-items:center; gap:8px; color: var(--primary-text-color); }
  .er { font-size:12px; color: var(--secondary-text-color); margin-top:3px; display:flex; align-items:center; gap:8px; }
  .er select { width:auto; }
  .promo { font-size:11px; color: var(--primary-color); background: rgba(46,106,82,.12); padding:1px 7px; border-radius:20px; }
  .solobadge { font-size:10.5px; font-weight:600; color: var(--primary-color); background: rgba(46,106,82,.12); padding:1px 8px; border-radius:20px; }
  .vact { display:flex; align-items:center; gap:10px; flex:none; }
  .vact .danger { color: var(--error-color,#c0392b); font-size:13px; }
  .mini { height:28px; padding:0 12px; border-radius:20px; border:1px solid var(--divider-color); background: var(--card-background-color); color: var(--secondary-text-color); font:inherit; font-size:12.5px; font-weight:500; cursor:pointer; }
  .mini.on { background: rgba(46,106,82,.12); border-color: var(--primary-color); color: var(--primary-color); }
  .sw { width:40px; height:23px; border-radius:20px; background: var(--divider-color); border:0; cursor:pointer; position:relative; flex:none; }
  .sw.on { background: var(--primary-color); }
  .sw::after { content:""; position:absolute; top:2px; left:2px; width:19px; height:19px; border-radius:50%; background:#fff; transition:transform .15s; }
  .sw.on::after { transform: translateX(17px); }
  .rm { width:32px; height:32px; border-radius:8px; border:0; background:none; color: var(--secondary-text-color); cursor:pointer; display:grid; place-items:center; }
  .rm:hover { background: rgba(192,57,43,.12); color: var(--error-color,#c0392b); }
  .rm svg { width:16px; height:16px; }
  .setrow { display:flex; align-items:flex-start; gap:16px; padding:14px 16px; border-top:1px solid var(--divider-color); }
  .setrow:first-child { border-top:0; }
  .setrow .st { flex:1; }
  .setrow .st b { font-weight:550; font-size:14.5px; color: var(--primary-text-color); }
  .setrow .st div { font-size:12.5px; color: var(--secondary-text-color); margin-top:2px; line-height:1.5; }
  .dprow { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
  .soon { margin:16px; padding:30px; border:1px dashed var(--divider-color); border-radius:12px; text-align:center; color: var(--secondary-text-color); }
  .soon b { color: var(--primary-text-color); font-size:16px; }
  .soon div { margin-top:6px; font-size:13px; }
  .pool { margin:0 16px 14px; border:1px dashed var(--divider-color); border-radius:12px; padding:12px 14px; }
  .pool .ph { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color: var(--secondary-text-color); margin-bottom:10px; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; min-height:34px; }
  .chip { display:inline-flex; align-items:center; gap:7px; background: var(--card-background-color); border:1px solid var(--divider-color); border-radius:22px; padding:3px 10px 3px 3px; font-size:13.5px; cursor:grab; user-select:none; color: var(--primary-text-color); }
  .chip.sel { box-shadow:0 0 0 2px var(--primary-color); border-color: var(--primary-color); }
  .cav { width:24px; height:24px; border-radius:50%; display:grid; place-items:center; color:#fff; font-weight:600; font-size:10px; }
  .rdot { width:15px; height:15px; border-radius:50%; display:grid; place-items:center; color:#fff; font-size:10px; font-weight:700; }
  .cx { width:16px; height:16px; border-radius:50%; display:grid; place-items:center; color: var(--secondary-text-color); cursor:pointer; }
  .cx svg { width:11px; height:11px; }
  .cx:hover { background: var(--divider-color); }
  .board { display:grid; grid-template-columns: repeat(auto-fill, minmax(220px,1fr)); gap:12px; margin:0 16px; }
  .crew { border:1px solid var(--divider-color); border-radius:12px; overflow:hidden; }
  .crewhd { display:flex; align-items:center; gap:9px; padding:11px 12px; border-bottom:1px solid var(--divider-color); }
  .cdot { width:11px; height:11px; border-radius:4px; }
  .crewhd b { flex:1; font-weight:550; font-size:15px; color: var(--primary-text-color); }
  .cn { font-size:12.5px; color: var(--secondary-text-color); }
  .cmix { padding:8px 12px; font-size:12px; color: var(--secondary-text-color); border-bottom:1px solid var(--divider-color); display:flex; gap:10px; flex-wrap:wrap; }
  .cmix .ld { display:inline-flex; align-items:center; gap:5px; }
  .cmix .cwarn { color:#9A6810; }
  .ld i { width:8px; height:8px; border-radius:50%; display:inline-block; }
  .crewbody { padding:10px 12px; display:flex; flex-wrap:wrap; gap:8px; min-height:44px; }
  .addcrew { border:1px dashed var(--divider-color); border-radius:12px; background:none; color: var(--secondary-text-color); font:inherit; font-weight:500; font-size:14px; cursor:pointer; min-height:100px; }
  .addcrew:hover { border-color: var(--primary-color); color: var(--primary-color); }
  .legend { display:flex; gap:16px; margin:14px 16px 0; font-size:12.5px; color: var(--secondary-text-color); }
  .legend .ld { display:inline-flex; align-items:center; gap:5px; }
  .clist { margin:0 16px; border:1px solid var(--divider-color); border-radius:12px; overflow:hidden; }
  .crow { display:flex; align-items:center; gap:12px; padding:12px 14px; border-top:1px solid var(--divider-color); }
  .crow:first-child { border-top:0; }
  .cmeta { flex:1; min-width:0; cursor:pointer; }
  .cmeta b { font-weight:550; font-size:15px; color: var(--primary-text-color); }
  .cact { display:flex; align-items:center; gap:4px; flex:none; }
  .csub { font-size:12.5px; color: var(--secondary-text-color); margin-top:2px; }
  .csub.danger { color: var(--error-color,#c0392b); }
  .cb { font-size:11.5px; font-weight:500; padding:1px 7px; border-radius:20px; background: var(--secondary-background-color); color: var(--secondary-text-color); }
  .cb.ok { background: rgba(46,106,82,.12); color: var(--primary-color); }
  .scrim { position:fixed; inset:0; background: rgba(20,26,22,.42); z-index:8; }
  .drawer { position:fixed; top:0; right:0; height:100%; width:min(440px,96vw); background: var(--card-background-color); border-left:1px solid var(--divider-color); z-index:9; display:flex; flex-direction:column; box-shadow:-8px 0 24px rgba(0,0,0,.15); }
  .dhd { display:flex; align-items:center; padding:16px; border-bottom:1px solid var(--divider-color); }
  .dhd b { flex:1; font-size:17px; font-weight:550; color: var(--primary-text-color); }
  .dbody { padding:16px; overflow-y:auto; flex:1; }
  .dbody label { display:block; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color: var(--secondary-text-color); margin:16px 0 7px; font-weight:500; }
  .dbody label:first-child { margin-top:0; }
  .seg { display:flex; background: var(--secondary-background-color); border-radius:9px; padding:3px; gap:2px; }
  .seg button { flex:1; border:0; background:none; font:inherit; font-size:13px; font-weight:500; color: var(--secondary-text-color); padding:7px 5px; border-radius:6px; cursor:pointer; }
  .seg button.on { background: var(--card-background-color); color: var(--primary-text-color); }
  .frow { display:flex; align-items:center; gap:8px; margin-top:10px; font-size:14px; color: var(--secondary-text-color); }
  .days { display:flex; gap:6px; margin-top:10px; }
  .psel { display:flex; flex-wrap:wrap; gap:7px; margin-top:4px; }
  .pchip { border:1px solid var(--divider-color); background: var(--card-background-color); border-radius:20px; padding:5px 12px; font:inherit; font-size:13px; cursor:pointer; color: var(--secondary-text-color); }
  .pchip.on { background: rgba(46,106,82,.12); border-color: var(--primary-color); color: var(--primary-color); font-weight:500; }
  .note { font-size:12.5px; color: var(--secondary-text-color); margin-top:8px; }
  .cked { display:flex; flex-direction:column; gap:6px; margin-top:4px; }
  .ckrow { display:flex; align-items:center; gap:6px; }
  .drow { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:18px; }
  .drow b { font-weight:500; font-size:14.5px; color: var(--primary-text-color); }
  .drow .sub { font-size:12.5px; color: var(--secondary-text-color); margin-top:2px; }
  .dft { display:flex; align-items:center; gap:10px; padding:14px 16px; border-top:1px solid var(--divider-color); }
  .btn.primary { background: var(--primary-color); border-color: var(--primary-color); color:#fff; }
  .standwrap { margin:0 16px; border:1px solid var(--divider-color); border-radius:12px; overflow:hidden; }
  .standrow { display:flex; align-items:center; gap:12px; padding:11px 14px; border-top:1px solid var(--divider-color); }
  .standrow:first-child { border-top:0; }
  .rank { width:22px; height:22px; border-radius:50%; background: var(--secondary-background-color); color: var(--secondary-text-color); font-size:12px; font-weight:600; display:grid; place-items:center; flex:none; }
  .standrow:first-child .rank { background: var(--primary-color); color:#fff; }
  .sname { font-weight:550; font-size:14.5px; color: var(--primary-text-color); min-width:90px; }
  .sbar { flex:1; height:10px; border-radius:6px; background: var(--secondary-background-color); overflow:hidden; }
  .sbar i { display:block; height:100%; border-radius:6px; }
  .sval { font-variant-numeric:tabular-nums; font-size:15px; color: var(--primary-text-color); min-width:32px; text-align:right; }
  .chartwrap { margin:0 16px; border:1px solid var(--divider-color); border-radius:12px; padding:14px; }
  .ptabs { display:flex; gap:4px; background: var(--secondary-background-color); border-radius:9px; padding:3px; margin-bottom:14px; width:fit-content; }
  .ptabs .tab.sel { background: var(--card-background-color); }
  .chartscroll { overflow-x:auto; }
  .chart { max-width:100%; }
  .chart .axis { stroke: var(--divider-color); stroke-width:1; }
  .chart .axl { fill: var(--secondary-text-color); font-size:11px; font-family:inherit; }
  .legend2 { display:flex; flex-wrap:wrap; gap:14px; margin-top:12px; font-size:12.5px; color: var(--secondary-text-color); }
  .legend2 .ld { display:inline-flex; align-items:center; gap:6px; }
  .legend2 .ld i { width:10px; height:10px; border-radius:3px; }
</style>`;

customElements.define("rota-admin-card", RotaAdminCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "rota-admin-card", name: "Rota Admin", description: "Manage Rota volunteers, crews, chores, and settings." });
