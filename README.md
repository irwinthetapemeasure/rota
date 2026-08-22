# Rota — chore rotation for Home Assistant

Rota is a self-contained Home Assistant integration for running rotating chores —
built for a **volunteer summer camp** (crews that shuffle weekly) and for a
**household** (a couple of people trading chores day to day), from the same tool.

It keeps all of its own data (people, crews, chores, points) in Home Assistant's
storage, and ships two Lovelace cards:

- **Rota** — a kiosk/tablet card: today's chores, day navigation, dayparts, a
  long-term list, points, and mark-done / approval / "who did it?" flows.
- **Rota admin** — an admin console: build crews, manage people, edit chores, a
  points dashboard, and per-instance settings.

> ⚠️ **Early testing.** This is a young project shared for feedback. Data lives in
> `.storage/rota.data`; back it up if you care about it.

## Features

- **Schedule-driven rotation** — who is on a chore depends only on the calendar,
  never on who did it last. Rotate between people, assign to one person, or to a
  crew.
- **Scheduled vs floating chores** — *scheduled* chores are pinned to set days
  (e.g. steam-mop Wed & Sat); *floating* chores sit in a long-term list until
  their due date, then drop into the day's schedule.
- **Crews** — build crews by hand each week; crews do chores together and shuffle
  weekly. Optional experience levels (Lead / Returning / New) as admin-only
  decision support.
- **Dayparts** — split the day into any number of sections (e.g. meals) so a
  chore can recur through the day (dishes after each meal).
- **Points** — optional per-chore points, a leaderboard, weekly/monthly/annual
  graphs, and configurable reset windows (history is always preserved).
- **Kiosk "steal"** — points credit whoever actually did the chore. Under the
  "All" view the tablet asks *who did it?*; no login required.
- **Approvals** — optional per-chore "a lead checks it before it counts".
- **Reminders** — optional per-person phone nudges about unfinished chores, with
  a master toggle.

## Install (HACS)

Rota isn't in the default HACS list yet — add it as a custom repository:

1. In Home Assistant, open **HACS → Integrations**.
2. Top-right **⋮ → Custom repositories**.
3. Repository: `https://github.com/irwinthetapemeasure/rota` — Category:
   **Integration**. Add.
4. Find **Rota** in the list, **Download**, then **restart Home Assistant**.

## Set up

1. **Settings → Devices & Services → Add Integration → Rota → Submit.**
2. That's it — a fresh instance starts empty. The Lovelace cards
   (`custom:rota-card`, `custom:rota-admin-card`) are registered automatically;
   you don't need to add anything to `configuration.yaml` or the Lovelace
   resources list.

### Add the dashboards

Create two dashboards (or two views), each with a single card. **Settings →
Dashboards → Add dashboard → (open it) → Edit → ⋮ Raw configuration editor**, and
paste:

**Admin** (for you):

```yaml
title: Rota Admin
views:
  - title: Admin
    path: admin
    icon: mdi:cog
    panel: true
    cards:
      - type: custom:rota-admin-card
```

**Tablet** (for the crew / wall tablet):

```yaml
title: Rota
views:
  - title: Rota
    path: today
    icon: mdi:broom
    panel: true
    cards:
      - type: custom:rota-card
        title: Rota
```

Open the **admin** dashboard first to add people, crews, chores and settings.

## Concepts

- **Solo user** — an individual who gets chores directly (bypasses crews). Turn
  on **Solo users** in Settings for a household; leave it off for a camp that
  works in crews.
- **Rotate people** — a chore alternates between the listed people. Use the
  editor's **Up today** picker (and the weekly preview) to choose who's first.
- **Scheduled vs floating** — set a weekly/monthly chore's **Type** in the
  editor. Scheduled = specific days; floating = do it any time before it's due.
- **Points reset** — in the **Points** tab, choose how often standings reset
  (none / weekly / every 2 weeks / monthly). Graphs still show all history.

## Services

Rota registers services you can call from automations or scripts:

| Service | What it does |
| --- | --- |
| `rota.mark_done` | Mark a chore done (`chore`, optional `date`, `by`, `part`). |
| `rota.approve` | Approve a pending completion. |
| `rota.undo` | Revert a completion (removes its points). |
| `rota.remind_now` | Fire reminders immediately (testing). |

## Notes for testers

- One Rota instance per Home Assistant.
- Everything is local; no cloud, no external requirements.
- Found a bug or have an idea? Please open an
  [issue](https://github.com/irwinthetapemeasure/rota/issues).

## License

[MIT](LICENSE)
