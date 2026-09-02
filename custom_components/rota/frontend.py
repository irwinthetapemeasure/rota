"""Serve and register Rota's Lovelace cards from within the integration.

Installing the integration makes `custom:rota-card` and `custom:rota-admin-card`
available automatically — no editing of `configuration.yaml` or the Lovelace
resources list.

Registration prefers **Lovelace resources** over ``add_extra_js_url``: resources
are loaded and awaited by the frontend *before* it renders a dashboard's cards,
which avoids a load-order race where the card is built before its module is
registered (seen as a random "Configuration error"). If Lovelace is in YAML mode
(no writable resource store), we fall back to ``add_extra_js_url``. The URL is
versioned by the manifest so a HACS update busts the browser cache.
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
    """Serve the card files and make them load reliably in the frontend.

    Guarded so it only runs once, even across reloads (static paths can't be
    registered twice)."""
    if hass.data.get(_FLAG):
        return

    root = Path(__file__).parent / "frontend"
    # cache_headers=True: the ?v=<version> query busts the cache on updates, so
    # each version is cached hard rather than inconsistently re-fetched.
    await hass.http.async_register_static_paths(
        [StaticPathConfig(f"{URL_BASE}/{card}", str(root / card), True) for card in CARDS]
    )

    integration = await async_get_integration(hass, DOMAIN)
    version = integration.version or "0"
    urls = {card: f"{URL_BASE}/{card}?v={version}" for card in CARDS}

    via = "extra_js_url"
    try:
        if await _register_resources(hass, urls):
            via = "lovelace resources"
        else:
            _add_extra_js(hass, urls)
    except Exception as err:  # noqa: BLE001 - never let card wiring break setup
        _LOGGER.warning("Rota: Lovelace resource registration failed (%s); using extra_js_url", err)
        _add_extra_js(hass, urls)

    hass.data[_FLAG] = True
    _LOGGER.info("Rota cards registered via %s (v%s)", via, version)


def _add_extra_js(hass: HomeAssistant, urls: dict[str, str]) -> None:
    for url in urls.values():
        add_extra_js_url(hass, url)


async def _register_resources(hass: HomeAssistant, urls: dict[str, str]) -> bool:
    """Register the cards in the Lovelace resource store. Returns False if that
    store isn't available (YAML-mode Lovelace) so the caller can fall back."""
    from homeassistant.components.lovelace.resources import ResourceStorageCollection

    lovelace = hass.data.get("lovelace")
    resources = getattr(lovelace, "resources", None)
    if resources is None and isinstance(lovelace, dict):
        resources = lovelace.get("resources")
    if not isinstance(resources, ResourceStorageCollection):
        return False

    await resources.async_get_info()  # ensure the store is loaded
    items = resources.async_items()
    for card, url in urls.items():
        base = f"{URL_BASE}/{card}"
        existing = next((it for it in items if str(it.get("url", "")).split("?")[0] == base), None)
        if existing is None:
            await resources.async_create_item({"res_type": "module", "url": url})
        elif existing.get("url") != url:
            await resources.async_update_item(existing["id"], {"res_type": "module", "url": url})
    return True
