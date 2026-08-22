"""Serve and register Rota's Lovelace cards from within the integration.

This means testers never touch `configuration.yaml` or the Lovelace resources
list — installing the integration makes `custom:rota-card` and
`custom:rota-admin-card` available automatically. The cards are versioned by the
manifest version so a HACS update busts the browser cache.
"""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

URL_BASE = "/rota_frontend"
CARDS = ["rota-card.js", "rota-admin-card.js"]
_FLAG = f"{DOMAIN}_frontend_registered"


async def async_register_frontend(hass: HomeAssistant) -> None:
    """Register the static path for the cards and add them as frontend modules.

    Guarded so it only runs once, even across reloads (static paths and module
    URLs can't be registered twice)."""
    if hass.data.get(_FLAG):
        return

    root = Path(__file__).parent / "frontend"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(f"{URL_BASE}/{card}", str(root / card), False) for card in CARDS]
    )

    integration = await async_get_integration(hass, DOMAIN)
    version = integration.version or "0"
    for card in CARDS:
        add_extra_js_url(hass, f"{URL_BASE}/{card}?v={version}")

    hass.data[_FLAG] = True
    _LOGGER.info("Rota cards registered at %s (v%s)", URL_BASE, version)
