# Whiteboard data layout (version 2)

Status: agreed design, written in Phase 0. Phase 1 builds it. Nothing here is live yet. The current
Excalidraw board (version 1) runs until switch-over.

## Decisions this layout follows

| Decision | Phase |
|---|---|
| Existing boards are test data. Archive them and start fresh. No converter. | Start of Phase 1 |
| Content students must not move or erase lives in a separate locked-layer document. | Phase 4 |
| Images and PDF pages are stored in R2. The Yjs document holds only references. | Phase 3 |
| Tabs, per-student boards and Leading Mode are a separate effort. | Phase 5 |

## Engine flag

`VITE_BOARD_ENGINE` (frontend, build time) chooses the engine: `excalidraw` (default) or `tuteria`.
See `frontend/src/board/engine.ts`. Every client of one deployment runs the same engine. Two
engines must never edit the same database, because each one ignores the other's data.

## Documents

Hocuspocus document names don't change:

| Board | Document name |
|---|---|
| Main board of a space (kept across sessions) | `space:{spaceId}:main` |
| Breakout room board (one session) | `{sessionId}:{roomId}` |
| Locked layer of either board (Phase 4) | `{name}:locked` |

The server stores each document as opaque bytes in `boards.data`. The backend needs no change
for version 2.

## Root types in each document

| Name | Type | Holds |
|---|---|---|
| `meta` | `Y.Map` | `schemaVersion: 2` |
| `items` | `Y.Map<Y.Map>` | One nested map per item, keyed by item id |
| `assets` | `Y.Map<Y.Map>` | One entry per image, keyed by asset id |
| `elements`, `files` | — | **Reserved for version 1 (Excalidraw). Version 2 never reads or writes them.** |

Each item is a nested `Y.Map`, not a JSON string. Two people changing different fields of the same
item (one moves it, one changes its colour) then merge instead of one overwriting the other.

### Version check on load

- `meta.schemaVersion` missing and `items` empty: a new board. The first client with write access
  sets `schemaVersion: 2`.
- `meta.schemaVersion` missing and `elements` not empty: a version 1 board. The engine shows it
  as unsupported and writes nothing. This should not happen after the archive.
- `meta.schemaVersion` higher than the client knows: the board opens read-only and asks the
  person to refresh.

## Items

### Coordinates

- World units, origin top-left, y grows downward.
- `x, y` is the item's top-left corner before rotation.
- `rotation` is in radians, around the item's centre.
- Points inside an item are relative to its `x, y`.

### Fields every item has

| Field | Type | Notes |
|---|---|---|
| `id` | string | Same as the map key |
| `type` | string | One of the types below |
| `x`, `y` | number | |
| `rotation` | number | Default `0` |
| `z` | string | Fractional index. Sort with plain `<` comparison, not `localeCompare`. |
| `createdBy` | string | Participant id. How the client learns it is settled in Phase 1. |
| `createdAt` | number | `Date.now()` |
| `stroke` | string | Hex colour |
| `fill` | string \| null | Hex colour, or none |
| `strokeWidth` | number | World units |
| `opacity` | number | 0 to 1 |

### Item types

| `type` | Extra fields |
|---|---|
| `stroke` | `tool: "pen" \| "highlighter"`, `points: Y.Array<number>` flat `[x, y, pressure, …]`, `done: boolean` |
| `rect`, `ellipse` | `w`, `h` |
| `line`, `arrow` | `points: number[]` `[x1, y1, x2, y2]`, `arrowStart: boolean`, `arrowEnd: boolean` |
| `text` | `text: Y.Text`, `fontSize`, `fontFamily`, `align: "left" \| "center" \| "right"`, `w: number \| null` (wrap width) |
| `image` | `assetId`, `w`, `h` |
| `pdfPage` | `assetId`, `w`, `h`, `pdfName`, `pageNumber` |

From Phase 4, `pdfPage` items are written to the locked-layer document.

### Live drawing

1. On pointer down, the engine creates a `stroke` item with `done: false`.
2. While drawing, it appends new points to `points` in batches, about every 32 ms. Yjs then sends
   only the new points. The current board re-sends the whole stroke every 100 ms.
3. On pointer up, it sets `done: true`.

### Deleting

Delete the map key. There is no `isDeleted` flag. Yjs cleans up deleted data, and undo can bring
the item back.

## Assets

| Field | Type | Notes |
|---|---|---|
| `id` | string | Same as the map key |
| `mime` | string | e.g. `image/jpeg` |
| `width`, `height` | number | Pixel size of the stored image |
| `bytes` | number | File size |
| `url` | string | R2 location (Phase 3) |
| `dataURL` | string | Temporary, Phases 1 and 2 only. Removed when R2 upload ships. |
| `createdBy` | string | Participant id |

Phase 3 also adds a cleanup job for assets that no item references.

PDF pages are drawn in the browser by `frontend/src/board/pdf/rasterizePdf.ts`: 1100 px wide,
JPEG quality 0.78, at most 20 pages per import.

## Writes, undo and remote changes

- Every local change runs inside `doc.transact(fn, LOCAL_ORIGIN)`.
- `Y.UndoManager` watches `items`, with `trackedOrigins = { LOCAL_ORIGIN }`. Each person undoes only
  their own changes. Remote changes never enter local undo.

## Awareness (live presence, never saved)

| Field | Value | Phase |
|---|---|---|
| `user` | `{ name, role, color }`. Observers send nothing. | 1 (one colour per person: Phase 2) |
| `cursor` | `{ x, y }` in world units, or `null`. Sent at most every 100 ms. | 1 |
| `tool` | Current tool name | 2 |
| `laser` | Recent trail `[x, y, time, …]` | 2 |
| `viewport` | `{ x, y, zoom }`, reserved for Leading Mode | 5 |

## Permissions

- **Now and Phases 1 to 3:** the server's per-connection `readOnly` check (`boards/service.ts`)
  decides who may write a document. The client hides editing tools when `canEdit` is false.
- **Phase 4:** `{name}:locked` uses this same layout. Only admins and tutors can write to it;
  everyone else connects read-only. It is drawn underneath the main document.

## Archiving the version 1 boards (start of Phase 1)

Do this once, before anyone uses `VITE_BOARD_ENGINE=tuteria` against a database. Stop the backend
first, so Hocuspocus cannot save an open board back.

Export to a file, not to a new table. A table that Prisma doesn't know about makes
`prisma migrate dev` report drift and offer to reset the database.

```sh
pg_dump "<database url>" --table=public.boards --data-only --file=boards-archive-<date>.sql
psql "<database url>" -c 'DELETE FROM boards;'
```
