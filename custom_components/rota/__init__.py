"""The Rota integration — self-contained chore rotation for Home Assistant.

Set up through the UI (Settings → Devices & Services → Add Integration → Rota).
On setup it loads its store, registers services + the websocket API, serves and
registers its Lovelace cards, and exposes today's schedule as a sensor.
"""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .coordinator import RotaCoordinator
from .frontend import async_register_frontend
from .services import async_register_services
from .ws import async_register_ws

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["sensor"]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Rota from a config entry."""
    coordinator = RotaCoordinator(hass)
    await coordinator.async_init()
    hass.data[DOMAIN] = coordinator

    async_register_services(hass)
    async_register_ws(hass)
    await async_register_frontend(hass)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _LOGGER.info("Rota ready: %d items due today", coordinator.data.get("count", 0))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Tear down the sensor platform. Services / frontend stay registered (they're
    cheap and safe when idle), and the store persists on disk."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        coordinator = hass.data.pop(DOMAIN, None)
        if coordinator is not None:
            coordinator.async_stop()
    return unload_ok
