"""Config flow for Rota — a single click, no options to fill in.

Rota holds everything (people, crews, chores, settings) in its own store and is
managed from the admin dashboard, so setup is just confirming you want it.
"""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow
from homeassistant.data_entry_flow import FlowResult

from .const import DOMAIN


class RotaConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the (single-instance) Rota config flow."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        """Confirm-and-create. Only one Rota instance is allowed."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        if user_input is not None:
            return self.async_create_entry(title="Rota", data={})
        return self.async_show_form(step_id="user")
