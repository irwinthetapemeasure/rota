"""Constants for the Rota integration."""

DOMAIN = "rota"

STORAGE_KEY = "rota.data"
STORAGE_VERSION = 1

# How often the coordinator recomputes "today" (so the schedule rolls over
# across midnight without needing an external trigger).
UPDATE_INTERVAL_MINUTES = 30
