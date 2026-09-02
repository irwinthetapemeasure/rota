"""Coordinator: holds Rota's state and the derived 'today' snapshot."""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
import homeassistant.util.dt as dt_util

from . import engine
from .const import DOMAIN, UPDATE_INTERVAL_MINUTES
from .store import RotaStore

_LOGGER = logging.getLogger(__name__)


class RotaCoordinator(DataUpdateCoordinator):
    """Loads the store once, then recomputes today's schedule on a timer."""

    def __init__(self, hass: HomeAssistant) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(minutes=UPDATE_INTERVAL_MINUTES),
        )
        self.store = RotaStore(hass)
        self._reminder_unsub = None

    async def async_init(self) -> None:
        """Load persisted state, then do the first schedule computation."""
        await self.store.load()
        self.schedule_reminders()
        _LOGGER.info(
            "Rota loaded: %d chores, %d volunteers, %d crews",
            len(self.store.data.get("chores", [])),
            len(self.store.data.get("volunteers", [])),
            len(self.store.data.get("crews", [])),
        )
        await self.async_refresh()

    async def _async_update_data(self) -> dict[str, Any]:
        return self.compute_snapshot(dt_util.now().date())

    def compute_snapshot(self, on: date) -> dict[str, Any]:
        """The schedule for any date — used by the sensor (today) and the
        rota/schedule websocket command (for day navigation)."""
        now = dt_util.now()
        today = now.date()
        data = self.store.data
        settings = data.get("settings", {})
        dayparts = settings.get("dayparts") or []
        dp_ids = [dp.get("id") for dp in dayparts]

        day = engine.day_items(data, on, today, dp_ids)
        longterm = engine.longterm_items(data, on, today)
        bonus = engine.bonus_items(data, on, today)
        since = engine.points_period_start(settings, today)
        return {
            "date": on.isoformat(),
            "is_today": on == today,
            "sections": bool(settings.get("sections")),
            "dayparts": dayparts,
            "current_daypart": engine.current_daypart(dayparts, now.strftime("%H:%M")),
            "day": day,
            "longterm": longterm,
            "bonus": bonus,
            "count": len(day) + len(longterm),
            "points": engine.points_totals(data, since),
            "points_reset": settings.get("points_reset", "none"),
            "points_since": since.isoformat() if since else None,
            "points_on": bool(settings.get("points")),
            "candidates": engine.credit_candidates(data),
        }

    # --- mutations (used by services and, later, the front ends) -------------

    def _chore(self, ref: str) -> dict[str, Any]:
        chore = engine.find_chore(self.store.data, ref)
        if chore is None:
            raise HomeAssistantError(f"Rota: no chore '{ref}'")
        return chore

    async def async_mark_done(
        self, ref: str, on: date, by: str | None = None, part: str | None = None,
        helpers: list[str] | None = None,
    ) -> str:
        result = engine.mark_done(
            self.store.data, self._chore(ref), on, dt_util.now().isoformat(), by, part, helpers
        )
        await self._persist()
        return result

    async def async_remove_points_day(self, subject: str, date_iso: str) -> int:
        removed = engine.remove_points_on(self.store.data, subject, date_iso)
        await self._persist()
        return removed

    async def async_adjust_points(self, subject: str, delta: int, note: str | None = None) -> None:
        engine.adjust_points(self.store.data, subject, delta, dt_util.now().isoformat(), note)
        await self._persist()

    async def async_approve(
        self, ref: str, on: date, by: str | None = None, part: str | None = None
    ) -> str | None:
        result = engine.approve(
            self.store.data, self._chore(ref), on, dt_util.now().isoformat(), by, part
        )
        await self._persist()
        return result

    async def async_undo(self, ref: str, on: date, part: str | None = None) -> str | None:
        result = engine.undo(self.store.data, self._chore(ref), on, part)
        await self._persist()
        return result

    async def async_toggle_check(
        self, ref: str, on: date, index: int, part: str | None = None
    ) -> list[int]:
        result = engine.toggle_check(self.store.data, self._chore(ref), on, index, part)
        await self._persist()
        return result

    async def _persist(self) -> None:
        await self.store.save()
        await self.async_refresh()

    # --- admin API -----------------------------------------------------------

    def admin_state(self) -> dict[str, Any]:
        """The raw editable data the admin console works with."""
        d = self.store.data
        today = dt_util.now().date()
        return {
            "settings": d.get("settings", {}),
            "volunteers": d.get("volunteers", []),
            "crews": d.get("crews", []),
            "chores": d.get("chores", []),
            # anchors so the editor can compute who's up "today" for any
            # frequency without re-deriving the calendar in the browser.
            "today_ordinal": today.toordinal(),
            "today_ym": today.year * 12 + (today.month - 1),
        }

    def points_report(self) -> dict[str, Any]:
        """Aggregated points for the admin dashboard (standings + graphs)."""
        return engine.points_report(self.store.data, dt_util.now().date())

    def async_stop(self) -> None:
        """Cancel the reminder timer (called when the entry is unloaded)."""
        if self._reminder_unsub:
            self._reminder_unsub()
            self._reminder_unsub = None

    async def async_apply(self, mutate) -> dict[str, Any]:
        """Run a pure mutator against the store, persist, refresh, return state."""
        mutate(self.store.data)
        await self._persist()
        self.schedule_reminders()  # settings/reminder time may have changed
        return self.admin_state()

    # --- reminders -----------------------------------------------------------

    def schedule_reminders(self) -> None:
        """(Re)register the daily reminder at the configured time, if enabled."""
        if self._reminder_unsub:
            self._reminder_unsub()
            self._reminder_unsub = None
        settings = self.store.data.get("settings", {})
        if not settings.get("notifications"):
            _LOGGER.debug("Rota reminders disabled")
            return
        raw = str(settings.get("reminder_time", "20:00"))
        try:
            hour, minute = (int(x) for x in raw.split(":")[:2])
        except (ValueError, TypeError):
            hour, minute = 20, 0
        self._reminder_unsub = async_track_time_change(
            self.hass, self._reminder_cb, hour=hour, minute=minute, second=0
        )
        _LOGGER.info("Rota reminders scheduled for %02d:%02d", hour, minute)

    @callback
    def _reminder_cb(self, now) -> None:
        self.hass.async_create_task(self.async_fire_reminders(now))

    async def async_fire_reminders(self, now=None) -> int:
        """Notify each active volunteer about their unfinished chores today."""
        now = now or dt_util.now()
        data = self.store.data
        settings = data.get("settings", {})
        if not settings.get("notifications"):
            return 0
        today = now.date()
        dp_ids = [dp.get("id") for dp in (settings.get("dayparts") or [])]
        items = engine.day_items(data, today, today, dp_ids) + engine.longterm_items(data, today)
        undone = [i for i in items if i.get("status") in ("todo", "overdue")]
        sent = 0
        for v in data.get("volunteers", []):
            if not v.get("active") or not v.get("notify"):
                continue
            name = v.get("name")
            mine, seen = [], set()
            for i in undone:
                key = (i.get("id"), i.get("daypart"))
                if key in seen:
                    continue
                if i.get("assignee") == name or (i.get("members") and name in i["members"]):
                    mine.append(i)
                    seen.add(key)
            if not mine:
                continue
            names = ", ".join(sorted({i.get("name") for i in mine}))
            try:
                await self.hass.services.async_call(
                    "notify",
                    v["notify"],
                    {
                        "title": "Chores still to do",
                        "message": f"{name}, you still have {len(mine)} chore(s) today: {names}",
                    },
                    blocking=False,
                )
                sent += 1
            except Exception as err:  # noqa: BLE001 - a bad notify target shouldn't break the rest
                _LOGGER.warning("Rota reminder to %s failed: %s", v.get("notify"), err)
        return sent
