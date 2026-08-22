"""Pure mutators for the admin API — operate on the store's data dict.

Kept HA-free so they're easy to reason about and test. The websocket layer
wraps each of these with persist + refresh.
"""

from __future__ import annotations

import re
import uuid
from typing import Any


def _new_id(name: str = "") -> str:
    base = re.sub(r"[^a-z0-9]+", "_", (name or "").lower()).strip("_")
    return f"{base}_{uuid.uuid4().hex[:4]}" if base else uuid.uuid4().hex[:8]


def _upsert(items: list[dict[str, Any]], item: dict[str, Any], name_for_id: str = "") -> dict[str, Any]:
    if not item.get("id"):
        item["id"] = _new_id(item.get(name_for_id, "") if name_for_id else "")
    existing = next((x for x in items if x.get("id") == item["id"]), None)
    if existing:
        existing.update(item)
        return existing
    items.append(item)
    return item


def upsert_volunteer(data: dict[str, Any], vol: dict[str, Any]) -> None:
    _upsert(data.setdefault("volunteers", []), vol, "name")


def delete_volunteer(data: dict[str, Any], vid: str) -> None:
    data["volunteers"] = [v for v in data.get("volunteers", []) if v.get("id") != vid]


def assign(data: dict[str, Any], vid: str, crew_id: str | None) -> None:
    for v in data.get("volunteers", []):
        if v.get("id") == vid:
            v["crew_id"] = crew_id


def upsert_crew(data: dict[str, Any], crew: dict[str, Any]) -> None:
    _upsert(data.setdefault("crews", []), crew, "name")


def delete_crew(data: dict[str, Any], cid: str) -> None:
    data["crews"] = [c for c in data.get("crews", []) if c.get("id") != cid]
    for v in data.get("volunteers", []):
        if v.get("crew_id") == cid:
            v["crew_id"] = None


def upsert_chore(data: dict[str, Any], chore: dict[str, Any]) -> None:
    _upsert(data.setdefault("chores", []), chore, "name")


def delete_chore(data: dict[str, Any], cid: str) -> None:
    data["chores"] = [c for c in data.get("chores", []) if c.get("id") != cid]


def update_settings(data: dict[str, Any], patch: dict[str, Any]) -> None:
    data.setdefault("settings", {}).update(patch)
