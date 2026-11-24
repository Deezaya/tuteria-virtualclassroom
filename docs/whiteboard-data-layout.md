# Whiteboard data layout (version 2)

Status: Phase 2 implements `meta`, `assets` (images inline, see below) and every item type except
`pdfPage`, plus awareness `user`, `color`, `cursor` and `laser`, behind `VITE_BOARD_ENGINE=tuteria`.
Code: `frontend/src/board/model/` and, per item type, `frontend/src/board/engine/items.ts`.
`pdfPage` and R2 storage come in Phase 3. The Excalidraw board (version 1) stays the default until
switch-over.

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
- `rotation` is in radians, around the centre of the item's box. Only box items (`rect`, `ellipse`,
  `text`, `image`) rotate. Strokes and lines keep `0`; a line is turned by moving its ends.
- Points inside an item are relative to its `x, y`.
- A text item's box size is not stored. It comes from laying out the text (`engine/textLayout.ts`):
  the width is `w` when set, otherwise the widest line. The line height is `1.25 × fontSize`.

### Fields every item has

| Field | Type | Notes |
|---|---|---|
| `id` | string | Same as the map key |
| `type` | string | One of the types below |
| `x`, `y` | number | |
| `rotation` | number | Default `0` |
| `z` | string | Fractional index. Sort with plain `<` comparison, not `localeCompare`. Two people adding at once can get the same key; ties sort by `id`. |
| `createdBy` | string | Participant id, from the `participantId` field of the board token reply. |
| `createdAt` | number | `Date.now()` |
| `stroke` | string | Hex colour |
| `fill` | string \| null | Hex colour, or none |
| `strokeWidth` | number | World units |
| `opacity` | number | 0 to 1 |
| `locked` | boolean | Eraser, select and delete skip locked items. Phase 4 enforces this on the server with the locked layer. |

### Item types

| `type` | Extra fields |
|---|---|
| `stroke` | `tool: "pen" \| "highlighter"`, `points: Y.Array<number>` flat `[x, y, pressure, …]`, `done: boolean` |
| `rect`, `ellipse` | `w`, `h` |
| `line`, `arrow` | `points: number[]` `[x1, y1, x2, y2]`, `arrowStart: boolean`, `arrowEnd: boolean` |
| `text` | `text: Y.Text`, `fontSize`, `fontFamily`, `align: "left" \| "center" \| "right"`, `w: number \| null` (wrap width) |
| `image` | `assetId`, `w`, `h` |
| `pdfPage` | `assetId`, `w`, `h`, `pdfName`, `pageNumber` (Phase 3) |

From Phase 4, `pdfPage` items are written to the locked-layer document.

A client skips item types it doesn't know, so an older client ignores newer types rather than
breaking.

### How each type looks

| Type | Drawing |
|---|---|
| `stroke`, pen | Smoothed line. Pressure (0 to 1) changes the width from 0.35× to 1.65× `strokeWidth`. Only styluses record real pressure; mice and fingers store 0.5, which gives 1×. |
| `stroke`, highlighter | Constant width, `opacity` 0.45, blended with "multiply" so writing shows through. |
| `rect` | Slightly rounded corners. `fill` null means outline only. |
| `ellipse` | Fills its box. |
| `line`, `arrow` | Straight line; arrow heads are open chevrons, about 3.5× `strokeWidth` long. |
| `text` | The Sora font, weight 500, in `stroke` colour. `strokeWidth` is unused (0). |
| `image` | The asset, stretched to `w × h`. A grey placeholder until it loads. |

### Defaults

Pen `#1f2937`, width 4. Highlighter `#facc15`, width 20. Text 24. Shapes have no fill. The
toolbar offers widths 2, 4, 8 and 14 (highlighter 12, 20, 32 and 48) and text sizes 16, 24, 36 and 56.

### Live editing

- Shapes are written as soon as the drag passes 3 screen pixels, then updated every 50 ms.
- Resizing, rotating and moving line ends are written every 50 ms, like moves.
- Typing goes straight into the item's `Y.Text` with the smallest possible change. Two people
  typing in different parts of the same text both keep their changes. An edit session is one undo
  step. A text box left empty is removed when the editor closes.

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
| `dataURL` | string | Temporary, Phase 2 only. Removed when R2 upload ships. |
| `createdBy` | string | Participant id |

**Phase 2 (temporary):** images are stored inline as `dataURL`. Before saving, an image is shrunk to
at most 1600 px on its long side and compressed: PNG when that keeps it under 1 MB, otherwise JPEG
at quality 0.85, then 0.7, then 0.55. Anything still over 1 MB is refused with a message. Images
come from the Upload button, from pasting (Ctrl+V) or from dropping a file on the board.

Only people with editing **and** the File uploads permission can add images (tutors and admins
always can). The client checks this. The server can't, because an image is just data inside the
board, so a student with editing could in principle write one. Phase 3 closes this gap: the R2
upload endpoint checks the permission, and the board stores only the URL.

Assets are not part of undo. Undoing an image insert removes the image item and leaves its asset
behind, unused. Phase 3 also adds a cleanup job for assets that no item references.

PDF pages are drawn in the browser by `frontend/src/board/pdf/rasterizePdf.ts`: 1100 px wide,
JPEG quality 0.78, at most 20 pages per import.

## Writes, undo and remote changes

- Every local change runs inside `doc.transact(fn, LOCAL_ORIGIN)`.
- `Y.UndoManager` watches `items`, with `trackedOrigins = { LOCAL_ORIGIN }`. Each person undoes only
  their own changes. Remote changes never enter local undo.
- Undo steps follow gestures, not time. Every gesture calls `endStep()` when it starts and ends, so
  one stroke, one erase or one move is exactly one step, however long it takes.
- An abandoned gesture (a second finger turns a stroke into a pinch) is reverted and removed from
  history with `discardStep()`.
- Moves are written every 50 ms while dragging, so others see them live.

## Awareness (live presence, never saved)

| Field | Value | Phase |
|---|---|---|
| `user` | `{ name, role, color }`, set by the shared connection hook. Observers send nothing. The new board ignores `user.color`, which is the Excalidraw board's fixed blue. | 1 |
| `color` | `#rrggbb`, this person's cursor colour. Picked from their participant id, so it stays the same when they reconnect. | 2 |
| `cursor` | `{ x, y }` in world units, or `null`. Sent at most every 100 ms, only by people who can edit. | 1 |
| `laser` | Flat `[x, y, …]` world points from the last 0.7 s, oldest first, or `null`. Sent at most every 50 ms while the laser is held down. When it becomes `null`, everyone's copy fades out over 0.6 s. Never saved. | 2 |
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
