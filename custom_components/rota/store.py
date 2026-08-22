"""Persistent storage for Rota, backed by Home Assistant's Store helper.

Everything Rota knows lives in a single ``.storage/rota.data`` document. A fresh
install starts empty — add people, crews and chores from the Rota admin
dashboard. Old / partial documents are tolerated and back-filled on load.
"""

from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import STORAGE_KEY, STORAGE_VERSION

# A universal default day split (any number of sections is allowed). Only shown
# on the tablet once "Split the day into sections" is turned on in Settings.
DEFAULT_DAYPARTS = [
    {"id": "morning", "name": "Morning", "start": "06:00"},
    {"id": "midday", "name": "Midday", "start": "11:00"},
    {"id": "afternoon", "name": "Afternoon", "start": "15:00"},
    {"id": "evening", "name": "Evening", "start": "19:00"},
]


def default_settings() -> dict[str, Any]:
    return {
        "solo": False,
        "approvals": False,
        "points": True,
        "experience": False,
        "sections": False,
        "notifications": False,
        "reminder_time": "20:00",
        "points_reset": "none",
        "dayparts": DEFAULT_DAYPARTS,
    }


def default_data() -> dict[str, Any]:
    """Seed data: an empty instance with sensible default settings."""
    return {
        "settings": default_settings(),
        "volunteers": [],
        "crews": [],
        "chores": [],
        "occurrences": {},
        "points_log": [],
    }


class RotaStore:
    """Thin wrapper around the HA Store with an in-memory copy."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.data: dict[str, Any] = {}

    async def load(self) -> dict[str, Any]:
        stored = await self._store.async_load()
        if stored is None:
            self.data = default_data()
            await self._store.async_save(self.data)
        else:
            self.data = stored
        self._normalize()
        return self.data

    def _normalize(self) -> None:
        """Tolerate older/partial documents so upgrades never crash on load."""
        if not isinstance(self.data.get("occurrences"), dict):
            self.data["occurrences"] = {}
        if not isinstance(self.data.get("points_log"), list):
            self.data["points_log"] = []
        settings = self.data.setdefault("settings", {})
        for key, val in default_settings().items():
            settings.setdefault(key, val)
        if not settings.get("dayparts"):
            settings["dayparts"] = DEFAULT_DAYPARTS
        for v in self.data.setdefault("volunteers", []):
            v.setdefault("id", v.get("name", "v"))
            v.setdefault("experience", "new")
            v.setdefault("weeks_active", 0)
            v.setdefault("active", True)
            v.setdefault("solo", False)
            v.setdefault("crew_id", None)
            v.setdefault("notify", None)
        for c in self.data.setdefault("crews", []):
            c.setdefault("id", c.get("name", "crew"))
            c.setdefault("color", "#4C7C9C")

    async def save(self) -> None:
        await self._store.async_save(self.data)
