"""Rota websocket API.

rota/schedule returns the computed schedule for any date, so the tablet can
flip backwards and forwards through the days. (The start of the richer API the
admin console will use in Phase 3.)
"""

from __future__ import annotations

from datetime import date

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
import homeassistant.util.dt as dt_util

from . import admin
from .const import DOMAIN


@callback
def async_register_ws(hass: HomeAssistant) -> None:
    @websocket_api.websocket_command(
        {vol.Required("type"): "rota/schedule", vol.Optional("date"): str}
    )
    @callback
    def handle_schedule(hass: HomeAssistant, connection, msg) -> None:
        coordinator = hass.data.get(DOMAIN)
        if coordinator is None:
            connection.send_error(msg["id"], "not_ready", "Rota not set up")
            return
        raw = msg.get("date")
        try:
            on = date.fromisoformat(raw) if raw else dt_util.now().date()
        except (ValueError, TypeError):
            connection.send_error(msg["id"], "invalid_date", f"Bad date: {raw!r}")
            return
        connection.send_result(msg["id"], coordinator.compute_snapshot(on))

    websocket_api.async_register_command(hass, handle_schedule)

    # --- admin API: read the raw editable state -----------------------------

    @websocket_api.websocket_command({vol.Required("type"): "rota/state"})
    @callback
    def handle_state(hass: HomeAssistant, connection, msg) -> None:
        coordinator = hass.data.get(DOMAIN)
        if coordinator is None:
            connection.send_error(msg["id"], "not_ready", "Rota not set up")
            return
        connection.send_result(msg["id"], coordinator.admin_state())

    websocket_api.async_register_command(hass, handle_state)

    @websocket_api.websocket_command({vol.Required("type"): "rota/points"})
    @callback
    def handle_points(hass: HomeAssistant, connection, msg) -> None:
        coordinator = hass.data.get(DOMAIN)
        if coordinator is None:
            connection.send_error(msg["id"], "not_ready", "Rota not set up")
            return
        connection.send_result(msg["id"], coordinator.points_report())

    websocket_api.async_register_command(hass, handle_points)

    # --- admin API: mutations (each returns the new state) ------------------

    def _mutation(command_type: str, schema: dict, mutate_factory):
        @websocket_api.websocket_command({vol.Required("type"): command_type, **schema})
        @websocket_api.async_response
        async def handler(hass: HomeAssistant, connection, msg) -> None:
            coordinator = hass.data.get(DOMAIN)
            if coordinator is None:
                connection.send_error(msg["id"], "not_ready", "Rota not set up")
                return
            state = await coordinator.async_apply(mutate_factory(msg))
            connection.send_result(msg["id"], state)

        websocket_api.async_register_command(hass, handler)

    _mutation(
        "rota/volunteer/save", {vol.Required("volunteer"): dict},
        lambda m: lambda d: admin.upsert_volunteer(d, m["volunteer"]),
    )
    _mutation(
        "rota/volunteer/delete", {vol.Required("target"): str},
        lambda m: lambda d: admin.delete_volunteer(d, m["target"]),
    )
    _mutation(
        "rota/assign", {vol.Required("volunteer_id"): str, vol.Required("crew_id"): vol.Any(str, None)},
        lambda m: lambda d: admin.assign(d, m["volunteer_id"], m["crew_id"]),
    )
    _mutation(
        "rota/crew/save", {vol.Required("crew"): dict},
        lambda m: lambda d: admin.upsert_crew(d, m["crew"]),
    )
    _mutation(
        "rota/crew/delete", {vol.Required("target"): str},
        lambda m: lambda d: admin.delete_crew(d, m["target"]),
    )
    _mutation(
        "rota/chore/save", {vol.Required("chore"): dict},
        lambda m: lambda d: admin.upsert_chore(d, m["chore"]),
    )
    _mutation(
        "rota/chore/delete", {vol.Required("target"): str},
        lambda m: lambda d: admin.delete_chore(d, m["target"]),
    )
    _mutation(
        "rota/settings/save", {vol.Required("settings"): dict},
        lambda m: lambda d: admin.update_settings(d, m["settings"]),
    )
