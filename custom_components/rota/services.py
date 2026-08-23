"""Rota services: mark_done, approve, undo.

These are the calls the crew tablet and automations use. Each resolves a chore
(by id or name), applies the state change for a date (default today), persists,
and refreshes the sensors.
"""

from __future__ import annotations

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall
import homeassistant.helpers.config_validation as cv
import homeassistant.util.dt as dt_util

from .const import DOMAIN
from .coordinator import RotaCoordinator

SERVICE_MARK_DONE = "mark_done"
SERVICE_APPROVE = "approve"
SERVICE_UNDO = "undo"
SERVICE_REMIND_NOW = "remind_now"
SERVICE_TOGGLE_CHECK = "toggle_check"

_SCHEMA = vol.Schema(
    {
        vol.Required("chore"): cv.string,
        vol.Optional("date"): cv.date,
        vol.Optional("by"): cv.string,
        vol.Optional("part"): cv.string,
    }
)

_CHECK_SCHEMA = vol.Schema(
    {
        vol.Required("chore"): cv.string,
        vol.Required("index"): vol.Coerce(int),
        vol.Optional("date"): cv.date,
        vol.Optional("part"): cv.string,
    }
)


def async_register_services(hass: HomeAssistant) -> None:
    """Register Rota's services (called once from async_setup)."""

    def _coord() -> RotaCoordinator:
        return hass.data[DOMAIN]

    def _on(call: ServiceCall):
        return call.data.get("date") or dt_util.now().date()

    async def mark_done(call: ServiceCall) -> None:
        await _coord().async_mark_done(
            call.data["chore"], _on(call), call.data.get("by"), call.data.get("part")
        )

    async def approve(call: ServiceCall) -> None:
        await _coord().async_approve(
            call.data["chore"], _on(call), call.data.get("by"), call.data.get("part")
        )

    async def undo(call: ServiceCall) -> None:
        await _coord().async_undo(call.data["chore"], _on(call), call.data.get("part"))

    async def remind_now(call: ServiceCall) -> None:
        await _coord().async_fire_reminders()

    async def toggle_check(call: ServiceCall) -> None:
        await _coord().async_toggle_check(
            call.data["chore"], _on(call), call.data["index"], call.data.get("part")
        )

    hass.services.async_register(DOMAIN, SERVICE_MARK_DONE, mark_done, schema=_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_APPROVE, approve, schema=_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_UNDO, undo, schema=_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_REMIND_NOW, remind_now)
    hass.services.async_register(DOMAIN, SERVICE_TOGGLE_CHECK, toggle_check, schema=_CHECK_SCHEMA)
