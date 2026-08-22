"""Rota's deterministic scheduling engine.

Pure functions, no Home Assistant imports — so they're trivially testable and
carry the whole rotation logic. Rotation is *schedule-driven*: who is on a chore
is a function of the calendar date only, never of who did it last.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

# Frequencies that belong in the always-visible "long-term" section rather than
# the day view. Everything else (daily, every_n) is a day chore.
LONG_TERM_FREQS = {"weekly", "biweekly", "monthly", "quarterly", "yearly"}

# Frequencies that are inherently day-pinned (they happen on specific days), so
# they're always "scheduled" regardless of any stored mode.
DAY_FREQS = {"daily", "every_n"}


def chore_mode(chore: dict[str, Any]) -> str:
    """How a chore is placed in the views:

    - ``scheduled``: pinned to specific days (e.g. steam-mop Wed & Sat). Shows in
      the *day view* only on its due days, never in long-term.
    - ``floating``:  must be done by a due date but timing is flexible. Lives in
      the *long-term* section until its due date, then drops into the day view.

    Daily / every-N chores are always scheduled. Weekly+ chores default to
    floating (matching the old behaviour) unless explicitly set to scheduled.
    """
    if chore.get("frequency", "daily") in DAY_FREQS:
        return "scheduled"
    mode = chore.get("mode")
    return mode if mode in ("scheduled", "floating") else "floating"


def cycle_index(frequency: str, on: date, interval: int = 1) -> int:
    """A counter that ticks once per occurrence of the chore's period.

    Successive occurrences differ by exactly 1, so ``index % n`` alternates
    cleanly through ``n`` assignees regardless of phase.
    """
    ordinal = on.toordinal()
    if frequency == "weekly":
        return ordinal // 7
    if frequency == "monthly":
        return on.year * 12 + (on.month - 1)
    if frequency == "every_n":
        return ordinal // max(int(interval or 1), 1)
    # daily (and unknown) tick every day
    return ordinal


def occurrence_index(chore: dict[str, Any], on: date) -> int:
    """A counter that ticks once per *due occurrence* of the chore.

    For a scheduled weekly chore that runs on several weekdays (e.g. Wed & Sat),
    this advances on each of those days, so a people-rotation cycles between
    people across the week rather than only flipping week to week. Everything
    else falls back to the period counter (``cycle_index``).
    """
    freq = chore.get("frequency", "daily")
    if freq == "weekly" and chore_mode(chore) == "scheduled":
        days = [d.lower()[:3] for d in (chore.get("days") or [])]
        idxs = sorted(_WEEKDAYS.index(d) for d in days if d in _WEEKDAYS)
        if idxs:
            week = (on.toordinal() - on.weekday()) // 7  # Monday-aligned week no.
            wd = on.weekday()
            pos = idxs.index(wd) if wd in idxs else 0
            return week * len(idxs) + pos
    return cycle_index(freq, on, int(chore.get("interval", 1) or 1))


def is_due(chore: dict[str, Any], on: date) -> bool:
    """Whether a chore occurs on the given date."""
    freq = chore.get("frequency", "daily")
    if freq == "daily":
        return True
    if freq == "every_n":
        return on.toordinal() % max(int(chore.get("interval", 1) or 1), 1) == 0
    if freq == "weekly":
        days = [d.lower()[:3] for d in (chore.get("days") or [])]
        return not days or _WEEKDAYS[on.weekday()] in days
    if freq == "monthly":
        return on.day == int(chore.get("day_of_month", 1))
    return True


def assignee(chore: dict[str, Any], on: date) -> str | None:
    """Who is responsible for the chore on the given date.

    - ``person``: a fixed owner.
    - ``people``: individuals take one turn each, in list order (household mode).
    - ``crew``:   the on-duty crew for this week (resolved in a later phase);
                  for now returns the configured crew name if any.
    """
    assign = chore.get("assign", "person")
    if assign == "person":
        return chore.get("person")
    if assign == "people":
        people = chore.get("people") or []
        if not people:
            return None
        idx = occurrence_index(chore, on) + int(chore.get("offset", 0) or 0)
        return people[idx % len(people)]
    if assign == "crew":
        return chore.get("crew")
    return None


def todays_chores(data: dict[str, Any], on: date) -> list[dict[str, Any]]:
    """The list of chores due on ``on`` with their computed assignee."""
    out: list[dict[str, Any]] = []
    for chore in data.get("chores", []):
        if not chore.get("active", True):
            continue
        if not is_due(chore, on):
            continue
        out.append(
            {
                "id": chore.get("id"),
                "name": chore.get("name"),
                "frequency": chore.get("frequency", "daily"),
                "assign": chore.get("assign", "person"),
                "assignee": assignee(chore, on),
                "points": chore.get("points", 0),
                "require_approval": chore.get("require_approval", False),
            }
        )
    return out


# --- long-term chores & dayparts ---------------------------------------------


def is_long_term(chore: dict[str, Any]) -> bool:
    """Weekly/monthly/etc. chores live in the always-visible long-term section."""
    return chore.get("frequency", "daily") in LONG_TERM_FREQS


def period_anchor(chore: dict[str, Any], on: date) -> date:
    """A stable date that identifies a long-term chore's current period.

    Occurrences are tracked per-period (this week / this month / …), not per
    exact due date, so a monthly chore reads as one item you tick once a month.
    """
    freq = chore.get("frequency", "monthly")
    if freq in ("weekly", "biweekly"):
        return on - timedelta(days=on.weekday())  # Monday of this week
    if freq == "monthly":
        return date(on.year, on.month, 1)
    if freq == "quarterly":
        return date(on.year, ((on.month - 1) // 3) * 3 + 1, 1)
    if freq == "yearly":
        return date(on.year, 1, 1)
    return on


def due_label(chore: dict[str, Any]) -> str:
    """A short human note of when a long-term chore is due."""
    freq = chore.get("frequency", "monthly")
    if freq in ("weekly", "biweekly"):
        return "This week"
    if freq == "monthly":
        return f"By the {_ordinal(int(chore.get('day_of_month', 1)))}"
    return {"quarterly": "This quarter", "yearly": "This year"}.get(freq, freq.title())


def _days_in_month(year: int, month: int) -> int:
    if month == 12:
        return 31
    return (date(year, month + 1, 1) - timedelta(days=1)).day


def floating_due(chore: dict[str, Any], on: date) -> date:
    """The due date of the floating period that contains ``on``.

    Weekly floats are due Sunday; monthly on their ``day_of_month`` (default
    end of month); quarterly/yearly on the last day of the period.
    """
    freq = chore.get("frequency", "monthly")
    anchor = period_anchor(chore, on)
    if freq in ("weekly", "biweekly"):
        return anchor + timedelta(days=6)  # Sunday of this week
    if freq == "monthly":
        dim = _days_in_month(on.year, on.month)
        dom = int(chore.get("day_of_month", dim) or dim)
        return date(on.year, on.month, min(max(dom, 1), dim))
    if freq == "quarterly":
        end_month = anchor.month + 2
        return date(anchor.year, end_month, _days_in_month(anchor.year, end_month))
    if freq == "yearly":
        return date(on.year, 12, 31)
    return on


def floating_status(data: dict[str, Any], chore: dict[str, Any], on: date, today: date) -> str:
    """Status for a floating chore, keyed to its period (one completion/period).
    Overdue only once its due date has actually passed."""
    occ = data.get("occurrences", {}).get(occ_key(chore["id"], period_anchor(chore, on)))
    if occ:
        return occ.get("status", "todo")
    return "overdue" if floating_due(chore, on) < today else "todo"


def in_day_view(chore: dict[str, Any], on: date, today: date) -> bool:
    """Whether the chore belongs in the day schedule for ``on``."""
    if chore_mode(chore) == "scheduled":
        return is_due(chore, on)
    # floating: appears from its due date onward (due today / overdue this period)
    return on >= floating_due(chore, on)


def in_longterm(chore: dict[str, Any], on: date) -> bool:
    """Whether the chore belongs in the long-term section for ``on`` (a floating
    chore that isn't due yet this period)."""
    return chore_mode(chore) == "floating" and on < floating_due(chore, on)


def _ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def current_daypart(dayparts: list[dict[str, Any]], now_hhmm: str) -> str | None:
    """The daypart whose window the clock is currently in (by start time)."""
    if not dayparts:
        return None
    current = dayparts[0].get("id")
    for dp in dayparts:
        if (dp.get("start") or "00:00") <= now_hhmm:
            current = dp.get("id")
    return current


# --- occurrence state machine -------------------------------------------------
#
# An occurrence is one chore on one date — and, for chores that run several
# times a day, one daypart. Default (unstored) state is `todo`. Actioned
# occurrences store {status, done_by, ts, …} keyed by chore|date[|part].


def find_chore(data: dict[str, Any], ref: str) -> dict[str, Any] | None:
    """Look up a chore by id (preferred) or name."""
    for chore in data.get("chores", []):
        if chore.get("id") == ref or chore.get("name") == ref:
            return chore
    return None


def occ_key(chore_id: str, on: date, part: str | None = None) -> str:
    base = f"{chore_id}|{on.isoformat()}"
    return f"{base}|{part}" if part else base


def resolve_status(
    data: dict[str, Any], chore: dict[str, Any], on: date, today: date, part: str | None = None
) -> str:
    """Derive an occurrence's status: done · pending · todo · overdue."""
    occ = data.get("occurrences", {}).get(occ_key(chore["id"], on, part))
    if occ:
        return occ.get("status", "todo")
    return "overdue" if on < today else "todo"


def mark_done(
    data: dict[str, Any], chore: dict[str, Any], on: date, ts: str, by: str | None = None, part: str | None = None
) -> str:
    """Mark an occurrence done — or pending, if it needs a lead's approval."""
    settings = data.get("settings", {})
    key = occ_key(chore["id"], on, part)
    needs_approval = bool(chore.get("require_approval")) and bool(settings.get("approvals"))
    if needs_approval:
        data.setdefault("occurrences", {})[key] = {"status": "pending", "done_by": by, "ts": ts}
        return "pending"
    data.setdefault("occurrences", {})[key] = {
        "status": "done",
        "done_by": by,
        "approved_by": by,
        "ts": ts,
    }
    _post_points(data, chore, on, ts, part, subject=by)
    return "done"


def approve(
    data: dict[str, Any], chore: dict[str, Any], on: date, ts: str, by: str | None = None, part: str | None = None
) -> str | None:
    """Approve a pending occurrence → done, posting points. No-op otherwise."""
    occ = data.get("occurrences", {}).get(occ_key(chore["id"], on, part))
    if not occ or occ.get("status") != "pending":
        return None
    occ["status"] = "done"
    occ["approved_by"] = by
    occ["approved_ts"] = ts
    _post_points(data, chore, on, ts, part, subject=occ.get("done_by"))
    return "done"


def undo(data: dict[str, Any], chore: dict[str, Any], on: date, part: str | None = None) -> str | None:
    """Revert an occurrence to todo and remove any points it earned."""
    occ = data.get("occurrences", {}).pop(occ_key(chore["id"], on, part), None)
    _remove_points(data, chore, on, part)
    return "todo" if occ else None


def _post_points(
    data: dict[str, Any], chore: dict[str, Any], on: date, ts: str, part: str | None = None,
    subject: str | None = None,
) -> None:
    settings = data.get("settings", {})
    if not settings.get("points") or not chore.get("points"):
        return
    _remove_points(data, chore, on, part)  # keep it idempotent — never double-post
    # Credit the actual doer when one is given (kiosk "steal" — someone other than
    # the rostered assignee did it), else fall back to the schedule's assignee.
    if subject:
        who = subject
    else:
        period = period_anchor(chore, on) if chore_mode(chore) == "floating" else on
        who = resolve_subject(data, chore, period)
    data.setdefault("points_log", []).append(
        {
            "key": occ_key(chore["id"], on, part),
            "subject": who,
            "chore": chore["id"],
            "points": chore.get("points", 0),
            "date": on.isoformat(),
            "ts": ts,
        }
    )


def _remove_points(data: dict[str, Any], chore: dict[str, Any], on: date, part: str | None = None) -> None:
    key = occ_key(chore["id"], on, part)
    data["points_log"] = [e for e in data.get("points_log", []) if e.get("key") != key]


def points_totals(data: dict[str, Any], since: date | None = None) -> dict[str, int]:
    """Sum the points log by subject (person or crew). If ``since`` is given,
    only count entries on or after that date (the current reset window)."""
    totals: dict[str, int] = {}
    cutoff = since.isoformat() if since else None
    for entry in data.get("points_log", []):
        subject = entry.get("subject")
        if subject is None:
            continue
        if cutoff and (entry.get("date") or "") < cutoff:
            continue
        totals[subject] = totals.get(subject, 0) + int(entry.get("points", 0))
    return totals


def points_period_start(settings: dict[str, Any], today: date) -> date | None:
    """Start date of the current points window, per the reset setting.
    ``None`` means points never reset (all-time)."""
    mode = settings.get("points_reset", "none")
    if mode == "weekly":
        return today - timedelta(days=today.weekday())  # this Monday
    if mode == "biweekly":
        monday = today - timedelta(days=today.weekday())
        if (monday.toordinal() // 7) % 2:  # anchor to an even ISO-week boundary
            monday -= timedelta(days=7)
        return monday
    if mode == "monthly":
        return date(today.year, today.month, 1)
    return None


def _add_month(d: date) -> date:
    return date(d.year + 1, 1, 1) if d.month == 12 else date(d.year, d.month + 1, 1)


def _bucket_totals(log: list[dict[str, Any]], start: date, end: date) -> dict[str, int]:
    lo, hi = start.isoformat(), end.isoformat()
    totals: dict[str, int] = {}
    for e in log:
        d = e.get("date") or ""
        if lo <= d < hi and e.get("subject") is not None:
            totals[e["subject"]] = totals.get(e["subject"], 0) + int(e.get("points", 0))
    return totals


def points_series(data: dict[str, Any], today: date, kind: str, n: int) -> list[dict[str, Any]]:
    """Last ``n`` buckets of points totals, oldest first. ``kind`` is
    week / month / year. Each bucket carries its start date and per-subject sums."""
    log = data.get("points_log", [])
    out: list[dict[str, Any]] = []
    if kind == "week":
        this_mon = today - timedelta(days=today.weekday())
        for i in range(n - 1, -1, -1):
            start = this_mon - timedelta(days=7 * i)
            out.append({"start": start.isoformat(), "totals": _bucket_totals(log, start, start + timedelta(days=7))})
    elif kind == "month":
        y, m = today.year, today.month
        for i in range(n - 1, -1, -1):
            mm = m - i
            yy = y
            while mm <= 0:
                mm += 12
                yy -= 1
            start = date(yy, mm, 1)
            out.append({"start": start.isoformat(), "totals": _bucket_totals(log, start, _add_month(start))})
    else:  # year
        for i in range(n - 1, -1, -1):
            start = date(today.year - i, 1, 1)
            out.append({"start": start.isoformat(), "totals": _bucket_totals(log, start, date(start.year + 1, 1, 1))})
    return out


def points_report(data: dict[str, Any], today: date) -> dict[str, Any]:
    """Everything the admin points dashboard needs: current standings (respecting
    the reset window), all-time totals, and weekly/monthly/annual series."""
    settings = data.get("settings", {})
    since = points_period_start(settings, today)
    subjects = sorted({e.get("subject") for e in data.get("points_log", []) if e.get("subject")})
    return {
        "reset": settings.get("points_reset", "none"),
        "since": since.isoformat() if since else None,
        "subjects": subjects,
        "current": points_totals(data, since),
        "alltime": points_totals(data),
        "weekly": points_series(data, today, "week", 12),
        "monthly": points_series(data, today, "month", 12),
        "annual": points_series(data, today, "year", 4),
    }


# --- crews -------------------------------------------------------------------


def active_crews(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Crews that have at least one active, non-solo member (they take part in
    the weekly shuffle)."""
    have = {
        v.get("crew_id")
        for v in data.get("volunteers", [])
        if v.get("active") and not v.get("solo") and v.get("crew_id")
    }
    return [c for c in data.get("crews", []) if c.get("id") in have]


def credit_candidates(data: dict[str, Any]) -> list[str]:
    """Who can be credited for a completion in the kiosk 'who did it?' picker:
    active solo individuals plus on-duty crews."""
    out: list[str] = []
    seen: set[str] = set()
    for v in data.get("volunteers", []):
        if v.get("active") and v.get("solo") and v.get("name") and v["name"] not in seen:
            seen.add(v["name"])
            out.append(v["name"])
    for c in active_crews(data):
        if c.get("name") and c["name"] not in seen:
            seen.add(c["name"])
            out.append(c["name"])
    return out


def crew_members(data: dict[str, Any], crew_id: str) -> list[dict[str, Any]]:
    return [
        v
        for v in data.get("volunteers", [])
        if v.get("active") and not v.get("solo") and v.get("crew_id") == crew_id
    ]


def crew_for_chore(data: dict[str, Any], chore: dict[str, Any], on: date) -> dict[str, Any] | None:
    """The on-duty crew for a crew chore on a date. Crews shuffle weekly; the
    chore's `offset` staggers it so different crews cover different chores."""
    crews = active_crews(data)
    if not crews:
        return None
    offset = int(chore.get("offset", 0) or 0)
    week = on.toordinal() // 7
    return crews[(offset + week) % len(crews)]


def resolve_subject(data: dict[str, Any], chore: dict[str, Any], on: date) -> str | None:
    """Who a completion is credited to — the on-duty crew for crew chores,
    otherwise the individual."""
    if chore.get("assign") == "crew":
        crew = crew_for_chore(data, chore, on)
        return crew.get("name") if crew else None
    return assignee(chore, on)


def _resolve_who(data: dict[str, Any], chore: dict[str, Any], on: date) -> tuple[str | None, dict[str, Any]]:
    """Returns (assignee label, extra fields) — crew chores also carry the crew
    and its member names for the tablet to show."""
    if chore.get("assign") == "crew":
        crew = crew_for_chore(data, chore, on)
        if not crew:
            return None, {"crew": None, "members": []}
        members = [m.get("name") for m in crew_members(data, crew["id"])]
        return crew.get("name"), {
            "crew": {"id": crew["id"], "name": crew.get("name"), "color": crew.get("color")},
            "members": members,
        }
    return assignee(chore, on), {}


# --- grouped views for the tablet --------------------------------------------


def _item(chore: dict[str, Any], who: str | None, status: str, on: date, part: str | None, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    item = {
        "id": chore.get("id"),
        "name": chore.get("name"),
        "frequency": chore.get("frequency", "daily"),
        "assign": chore.get("assign", "person"),
        "assignee": who,
        "points": chore.get("points", 0),
        "require_approval": chore.get("require_approval", False),
        "daypart": part,
        "date": on.isoformat(),
        "status": status,
    }
    if extra:
        item.update(extra)
    return item


def _occ_done_by(data: dict[str, Any], chore: dict[str, Any], on: date, part: str | None = None) -> str | None:
    occ = data.get("occurrences", {}).get(occ_key(chore["id"], on, part))
    return occ.get("done_by") if occ else None


def day_items(data: dict[str, Any], on: date, today: date, daypart_ids: list[str]) -> list[dict[str, Any]]:
    """The day schedule for ``on``: scheduled chores due that day (expanded per
    daypart) plus any floating chores that have come due."""
    out: list[dict[str, Any]] = []
    for chore in data.get("chores", []):
        if not chore.get("active", True) or not in_day_view(chore, on, today):
            continue
        if chore_mode(chore) == "floating":
            # keyed to the period so completing it here or in long-term agrees
            anchor = period_anchor(chore, on)
            who, extra = _resolve_who(data, chore, anchor)
            item = _item(chore, who, floating_status(data, chore, on, today), anchor, None, extra)
            item["due"] = due_label(chore)
            item["due_date"] = floating_due(chore, on).isoformat()
            item["floating"] = True
            item["done_by"] = _occ_done_by(data, chore, anchor)
            out.append(item)
            continue
        who, extra = _resolve_who(data, chore, on)
        parts = [p for p in (chore.get("dayparts") or []) if p in daypart_ids]
        if parts:
            for part in parts:
                item = _item(chore, who, resolve_status(data, chore, on, today, part), on, part, extra)
                item["done_by"] = _occ_done_by(data, chore, on, part)
                out.append(item)
        else:
            item = _item(chore, who, resolve_status(data, chore, on, today), on, None, extra)
            item["done_by"] = _occ_done_by(data, chore, on)
            out.append(item)
    return out


def longterm_items(data: dict[str, Any], on: date, today: date | None = None) -> list[dict[str, Any]]:
    """Floating chores not yet due this period — always shown until their due date."""
    out: list[dict[str, Any]] = []
    for chore in data.get("chores", []):
        if not chore.get("active", True) or not in_longterm(chore, on):
            continue
        anchor = period_anchor(chore, on)
        occ = data.get("occurrences", {}).get(occ_key(chore["id"], anchor))
        status = occ.get("status", "todo") if occ else "todo"
        who, extra = _resolve_who(data, chore, anchor)
        item = _item(chore, who, status, anchor, None, extra)
        item["due"] = due_label(chore)
        item["due_date"] = floating_due(chore, on).isoformat()
        item["done_by"] = occ.get("done_by") if occ else None
        out.append(item)
    return out
