"""Rota sensor: `sensor.rota_today`.

Its state is the number of items due today; its attributes carry the whole
computed day (per-daypart), the long-term list, points, and the kiosk metadata
(candidates, reset window) the tablet card reads.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import RotaCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the Rota sensor from the config entry."""
    coordinator: RotaCoordinator = hass.data[DOMAIN]
    async_add_entities([RotaTodaySensor(coordinator)])


class RotaTodaySensor(CoordinatorEntity[RotaCoordinator], SensorEntity):
    """Number of items due today, with the full schedule in attributes."""

    _attr_has_entity_name = False
    _attr_name = "Rota Today"
    _attr_unique_id = "rota_today"
    _attr_icon = "mdi:broom"
    _attr_native_unit_of_measurement = "chores"

    @property
    def native_value(self) -> int:
        return self.coordinator.data.get("count", 0)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        d = self.coordinator.data
        return {
            "date": d.get("date"),
            "sections": d.get("sections", False),
            "dayparts": d.get("dayparts", []),
            "current_daypart": d.get("current_daypart"),
            "day": d.get("day", []),
            "longterm": d.get("longterm", []),
            "bonus": d.get("bonus", []),
            "points": d.get("points", {}),
            "points_reset": d.get("points_reset", "none"),
            "points_since": d.get("points_since"),
            "points_on": d.get("points_on", False),
            "candidates": d.get("candidates", []),
        }
