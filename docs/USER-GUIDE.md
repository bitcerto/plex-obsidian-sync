# Plex Sync - User Guide

## 1) Overview

Plex Sync connects your Plex account (and optionally your Plex Media Server) with notes in Obsidian.

It synchronizes:

1. Movies and shows to Markdown notes.
2. The `watched` field between Plex and Obsidian.
3. Folder structure:
   - Obsidian in Portuguese: `Media-Plex/Filmes/...` and `Media-Plex/Series/...`
   - Obsidian in English: `Media-Plex/Movies/...` and `Media-Plex/Series/...`
   - The locale is read from Obsidian at sync time (does not depend on a previously saved locale).

## 2) What it does NOT do

1. Does not remove physical movie/show files from disk.
2. Does not delete items from the PMS library automatically.
3. Does not require an external script for normal plugin usage.

## 3) Requirements

1. Obsidian with Community Plugins enabled.
2. Plugin installed in `.obsidian/plugins/plex-sync`.
3. Internet access for Plex account login.
4. For server modes, network access to the PMS.

## 4) Installation

### 4.1 From the Obsidian Community Plugin Store

1. Open `Settings → Community plugins → Browse`.
2. Search for **Plex Sync**.
3. Click `Install`, then `Enable`.

### 4.2 Manual installation

```bash
mkdir -p "/path/to/vault/.obsidian/plugins/plex-sync"
cp manifest.json main.js versions.json "/path/to/vault/.obsidian/plugins/plex-sync/"
```

Then in Obsidian:

1. Open `Settings → Community plugins`.
2. Click `Reload plugins`.
3. Enable `Plex Sync`.

## 5) Authentication modes

### 5.1 Plex Account (no server) - `account_only`

Use this mode when you want to sync using only your Plex account.

Steps:

1. Under `Authentication mode`, choose `Plex Account (no server)`.
2. Click `Login with Plex`.
3. Complete the login in your browser.
4. Run `Plex Sync: Sync Now`.

This mode syncs the watchlist and watch history from your account.

### 5.2 Plex Account + Discovery - `hybrid_account`

Use this mode when you want to access your PMS libraries via your Plex account.

Steps:

1. Under `Authentication mode`, choose `Plex Account + Discovery`.
2. Click `Login with Plex`.
3. Click `Refresh servers`.
4. Choose your server under `Plex Server`.
5. Run `Plex Sync: Sync Now`.

### 5.3 Manual (PMS URL + Token) - `manual`

Use this when you want to point directly to a specific PMS.

Steps:

1. Under `Authentication mode`, choose `Manual (PMS URL + Token)`.
2. Fill in `Plex Base URL`.
3. Fill in `Plex Token`.
4. Run `Plex Sync: Sync Now`.

## 6) Main settings

1. `Libraries`: comma-separated. Empty = all `movie/show` libraries.
2. `Notes folder`: default `Media-Plex`.
3. `Conflict policy`:
   - `latest`: the side with the most recent change wins.
   - `plex`: Plex always wins.
   - `obsidian`: the note always wins.
4. `Sync mode`:
   - The plugin does not use a startup/interval timer.
   - Sync is triggered by events (`create`, `edit`, `delete` note) or manually via `Sync Now`.

## 7) Available commands

1. `Plex Sync: Sync Now` — incremental sync (processes only items changed since the last sync).
2. `Plex Sync: Force Full Rebuild` — deletes local state and performs a full scan of all items. Use when notes are out of sync, after changing the notes folder, or after state corruption.
3. `Plex Sync: Reset Local State` — deletes local state without triggering an immediate sync.
4. `Plex Sync: Show Last Sync Report` — displays the last sync report.
5. `Plex Sync: Login with Plex Account` — starts the PIN-based login flow.
6. `Plex Sync: Refresh Plex Servers` — updates the list of servers linked to your account (`hybrid_account` mode).
7. `Plex Sync: Logout Plex Account` — disconnects the Plex account.
8. `Plex Sync: Search and Add to Watchlist` — searches the Plex catalogue and adds to watchlist (`account_only` mode only).

## 8) How synchronization works

### 8.1 Pull (Plex → Obsidian)

1. Creates new notes for new items.
2. Updates metadata and the `watched` field.
3. In `account_only` mode, if an item has no `watched` status and no watchlist entry on the account, the note is removed on `Sync Now`.
4. Can recreate a locally deleted note when the item still exists and is active in Plex.
5. `Sync Now` runs in incremental mode by default (processes only changed items); `Force Full Rebuild` performs a full scan.
6. In `account_only` mode, watch history also uses an incremental window to reduce `Sync Now` time.

### 8.2 Push (Obsidian → Plex)

1. Changing `watched` in the frontmatter sends the change to Plex.
2. For shows, seasons and episodes also enter the sync flow.

### 8.3 Note deletion

When a note inside the configured folder is deleted, the plugin schedules a sync event (debounce of ~1.2s).

Result per mode:

1. `account_only`: attempts to remove from watchlist and clear watched status on the Plex account.
2. `hybrid_account`: clears `watched` on the PMS; if a valid Plex account is present, also attempts to remove from the account watchlist. Does not delete movies/shows from the PMS library.
3. `manual`: clears `watched` on the PMS. Does not delete movies/shows from the PMS library.

> **Note:** the Plex account activity feed (visible at `community.plex.tv`) is **not removed** when a note is deleted. Only watched status and watchlist are updated. "On Deck" (continue watching) is indirectly affected since it depends on watched status.

### 8.4 Events that trigger sync

1. Creation of a managed note inside `${notesFolder}`.
2. Edit of a managed note (e.g.: `watched`).
3. Deletion of a managed note.
4. Manual command `Plex Sync: Sync Now`.

## 9) Frontmatter fields

All fields managed by the plugin are automatically updated on each sync. The field names follow the Obsidian language setting (Portuguese or English).

| Field (EN) | Field (PT) | Description |
|---|---|---|
| watched | assistido | Watch status |
| my rating | minha nota | Your personal rating (0–10, never overwritten by Plex) |
| title | titulo | Title |
| type | tipo | `movie` or `show` |
| year | year | Release year |
| summary | resumo | Description |
| critic rating | nota critica | Critic score |
| audience rating | nota publico | Audience score |
| duration minutes | duracao minutos | Runtime in minutes |
| library | biblioteca | PMS library name |
| last viewed at plex | ultima visualizacao plex | Last watched date in Plex |
| synced at | sincronizado em | Last sync timestamp |

## 10) Security

1. Sensitive tokens are stored in local device storage.
2. Tokens are not written to technical vault files.
3. Server cache is saved without `accessToken`.
4. Debug logs mask tokens in URLs.
5. Distributed lock prevents simultaneous sync across multiple devices.

## 11) Technical files created in the vault

Inside `${notesFolder}`:

1. `.plex-obsidian-state*.json`
2. `.plex-obsidian-lock.json`
3. `.plex-obsidian-last-report.json`
4. `.plex-servers-cache.json`

## 12) Multi-device (Windows / Linux / Android)

1. Use the same vault on all devices.
2. If using LiveSync, let the technical lock file sync alongside your notes.
3. Each device must log in to the plugin locally.
4. If another device holds the lock, wait for the TTL to expire.

## 13) Troubleshooting

### 13.1 "0 servers found"

1. Confirm the PMS is linked to the same Plex account you are logged into.
2. In `hybrid_account` mode, click `Refresh servers`.
3. If needed, temporarily switch to `manual` mode.

### 13.2 "lock held by ..."

1. Another device is currently syncing.
2. Wait for the TTL to expire and try again.

### 13.3 Item did not appear after `Sync Now`

1. Check the current mode (`account_only` vs `hybrid/manual`).
2. Check the `Libraries` filter setting.
3. Open `Show Last Sync Report` and review errors.

### 13.4 I deleted a note and it came back

This is expected when the item still exists in Plex, particularly in modes with a PMS.

## 14) FAQ

### Does removing from the library delete the video file?

1. Via the plugin: no.
2. Via the PMS: it may delete the file only if the media deletion option is enabled on the server.

### Do I need an external script?

No. The official workflow is through the Obsidian plugin only.
