# Whiteboard data layout (version 2)

Status: Phase 5 adds tabs, Leading Mode (switched from the Host controls panel), PDF pages on their
own tabs, and one shared websocket for both board documents. Phase 4 added the
server-enforced locked layer (`{name}:locked`) and one undo history across both documents. Phase 3
added every item type including `pdfPage` and `assets` stored in Cloudflare R2. All behind
`VITE_BOARD_ENGINE=tuteria`. Code:
`frontend/src/board/model/`, per item type `frontend/src/board/engine/items.ts`, storage
`backend/src/services/storage.ts` and `backend/src/modules/boards/uploads.ts`. The Excalidraw board
(version 1) stays the default until switch-over.

## Decisions this layout follows

| Decision | Phase |
|---|---|
| Existing boards are test data. Archive them and start fresh. No converter. | Start of Phase 1 |
| Content students must not move or erase lives in a separate locked-layer document. | Phase 4 |
| Images and PDF pages are stored in R2. The Yjs document holds only references. | Phase 3 |
| Tabs and Leading Mode are a separate effort. | Phase 5 |
| No per-student boards: they aren't in the PRD and Lessonspace doesn't have them. | Phase 5 cleanup |

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
| Locked layer of any board | `{name}:locked`, e.g. `space:{spaceId}:main:locked` |

The server stores each document as opaque bytes in `boards.data`. Both documents of a board use the
same layout below. The browser asks for each with its own token: `POST /boards/{sessionId}/token`
with `layer: "locked"` returns a token for the locked layer.

Both documents of the board travel over **one websocket** (`sync/sharedSocket.ts`). Hocuspocus still checks each
document's token on its own. The Excalidraw board keeps its own connection.

## Root types in each document

| Name | Type | Holds |
|---|---|---|
| `meta` | `Y.Map` | `schemaVersion: 2`. In the locked layer also `leading` (see Leading Mode). |
| `items` | `Y.Map<Y.Map>` | One nested map per item, keyed by item id |
| `assets` | `Y.Map<Y.Map>` | One entry per image, keyed by asset id |
| `tabs` | `Y.Map<Y.Map>` | The board's tabs, keyed by tab id. **Locked layer only**, so only hosts can change it. See Tabs. |
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
| `locked` | boolean | Only from Phase 3, when PDF pages were locked inside the main document (checked in the browser only). New items always write `false`: an item is locked by being in the locked layer. |
| `tab` | string | The tab the item is on. Missing (items from before Phase 5) means `"main"`. |

### Item types

| `type` | Extra fields |
|---|---|
| `stroke` | `tool: "pen" \| "highlighter"`, `points: Y.Array<number>` flat `[x, y, pressure, …]`, `done: boolean` |
| `rect`, `ellipse` | `w`, `h` |
| `line`, `arrow` | `points: number[]` `[x1, y1, x2, y2]`, `arrowStart: boolean`, `arrowEnd: boolean` |
| `text` | `text: Y.Text`, `fontSize`, `fontFamily`, `align: "left" \| "center" \| "right"`, `w: number \| null` (wrap width) |
| `image` | `assetId`, `w`, `h` |
| `pdfPage` | `assetId`, `w`, `h`, `pdfId` (shared by every page of one import), `pdfName`, `pageNumber` |

PDF pages placed as "locked" are written to the locked-layer document.

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
| `pdfPage` | Like `image`, with a thin grey page edge. |

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
| `mime` | string | `image/jpeg`, `image/png` or `image/webp` |
| `width`, `height` | number | Pixel size of the stored image |
| `bytes` | number | File size |
| `key` | string | R2 object key: `spaces/{spaceId}/boards/{assetId}.{jpg\|png\|webp}` |
| `url` | string | Unused (always null). |
| `dataURL` | string | Phase 2 only. Older boards may still have inline images; they keep working. New files never use it. |
| `createdBy` | string | Participant id |

**The file itself is never in the board.** The board stores the R2 key; the image lives in a
private R2 bucket.

### Uploading

1. The browser asks `POST /boards/{sessionId}/uploads` with `{ kind, contentType, bytes }`.
2. The backend checks the person (see Permissions), then returns a new `assetId`, the `key` and an
   upload link valid for 10 minutes. The link is signed for that exact content type and size, so R2
   refuses any other file.
3. The browser uploads straight to R2 (`PUT`), with a progress bar, and retries once if the network
   drops.
4. Only then does it add the asset and the item to the board.

Limits: images 10 MB, PDF pages 8 MB each (both after the browser has shrunk them). Images are
shrunk to at most 1600 px on the long side; PDF pages are drawn 1600 px wide as JPEG at quality 0.8.

### Viewing

R2 is private. The browser asks `POST /boards/{sessionId}/assets/urls` with up to 100 keys, and gets
view links valid for 1 hour. Only admitted participants of that session get links, and only for keys
of that session's space. The browser batches these requests, caches the links and renews them
5 minutes before they expire. An image that has loaded stays on screen when its link is renewed.

Images load only when their item comes near the visible area, so a long PDF loads page by page as
people scroll.

### Not done yet

Assets are not part of undo, and nothing deletes R2 files when their items are deleted. That's
deliberate for now, so undo can bring an item back. A cleanup job for files no board uses is still
to do.

## Writes, undo and remote changes

- Every local change runs inside `doc.transact(fn, LOCAL_ORIGIN)`.
- `Y.UndoManager` watches `items`, with `trackedOrigins = { LOCAL_ORIGIN }`. Each person undoes only
  their own changes. Remote changes never enter local undo.
- Undo steps follow gestures, not time. Every gesture calls `endStep()` when it starts and ends, so
  one stroke, one erase or one move is exactly one step, however long it takes.
- An abandoned gesture (a second finger turns a stroke into a pinch) is reverted and removed from
  history with `discardStep()`.
- Moves are written every 50 ms while dragging, so others see them live.
- Adding, renaming and deleting a tab are undo steps too. Deleting a tab deletes everything on it
  (both layers) in the same step, so undo brings it all back. Undo can change a tab you aren't
  looking at.
- **One history for both documents** (`model/history.ts`). Each document keeps its own
  `Y.UndoManager`; the shared history records which document(s) each step touched. Undo always
  reverts this person's latest step. A step that changes both documents at once (locking,
  unlocking, deleting a selection that spans both) is one step and is undone in one go.

## Awareness (live presence, never saved)

| Field | Value | Phase |
|---|---|---|
| `user` | `{ name, role, color }`, set by the shared connection hook. Observers send nothing. The new board ignores `user.color`, which is the Excalidraw board's fixed blue. | 1 |
| `color` | `#rrggbb`, this person's cursor colour. Picked from their participant id, so it stays the same when they reconnect. | 2 |
| `cursor` | `{ x, y }` in world units, or `null`. Sent at most every 100 ms, only by people who can edit. | 1 |
| `laser` | Flat `[x, y, …]` world points from the last 0.7 s, oldest first, or `null`. Sent at most every 50 ms while the laser is held down. When it becomes `null`, everyone's copy fades out over 0.6 s. Never saved. | 2 |
| `pid` | This person's participant id, so others can find the tutor leading or a student's tab. | 5 |
| `tab` | The tab this person is looking at. Cursors and lasers show only to people on the same tab. | 5 |
| `viewport` | `{ tab, x, y, w, h }`: the part of the board on the leading tutor's screen, in world units. Only the tutor leading sends it, at most every 100 ms; otherwise `null`. | 5 |

## Permissions

- The server's per-connection `readOnly` check (`boards/service.ts`) decides who may write a
  document. The client hides editing tools when `canEdit` is false.
- **Uploads (server-checked):** observers never. Tutors and admins always. Students and guests need
  editing; for images also File uploads. Only tutors and admins can add PDF pages.
- **Locked layer (server-checked):** see the next section.
- **Tabs and Leading Mode (server-checked):** both live in the locked layer, so only tutors and
  admins can change them.

## Locked layer

Each board has a second document, `{name}:locked`, drawn **underneath** the main document.

| Who | Main document | Locked layer |
|---|---|---|
| Tutor or admin | Writes | Writes |
| Student or guest with editing | Writes | Read-only |
| Student or guest without editing | Read-only | Read-only |
| Observer, or anyone in spy mode | Read-only | Read-only |

The server sets this when the connection opens (`onAuthenticate`) and keeps it when a tutor changes
Editing (`updateBoardParticipantEditing`): the permission never makes a locked layer writable for
anyone but a host. A locked layer passes the same board checks as its board (own main board, own
breakout room, or spy mode), so it works in breakout rooms too.

In the browser:

- Items in the locked layer can't be moved, resized or erased by anyone, tutors included. Students
  can draw on top of them, in the main document.
- Tutors and admins can select locked items, to delete them or unlock them. Students can't select
  them at all.
- **Lock** (selection bar, tutors and admins) moves the selected items into the locked layer.
  **Unlock** moves them back. The item keeps its id and author and goes on top of its new layer.
  Images and PDF pages bring their asset entry with them. Both can be undone.
- Live cursors and the laser travel only on the main document.

## Tabs

A board has one or more tabs (pages). The list is the locked layer's `tabs` map:

| Field | Type | Notes |
|---|---|---|
| `name` | string | Up to 40 characters |
| `z` | string | Fractional index: the tab order |
| `pdfId` | string, optional | Set on tabs made by "each page on its own tab" |
| `createdBy`, `createdAt` | | As for items |

- A board with an empty `tabs` map has one tab, `"main"`, called "Page 1". It holds every item
  written before tabs existed. The first change to the list writes `"main"` into the map.
- Each item's `tab` says where it is. The engine shows only the current tab's items; new items go on
  the current tab. Items whose tab no longer exists are not shown.
- Tutors and admins add (+), rename (double-click) and delete (x) tabs. The last tab can't be
  deleted. Everyone else can switch tabs, except while following in Leading Mode.
- Each person's tab and camera are their own (not saved). The camera is remembered per tab.

## Leading Mode

Switched on and off by tutors and admins in the **Host controls** (crown) panel, not on the board.
The panel and the board talk through `board/leadingControl.ts`, which has no board code, so the panel
doesn't load the board. With the Excalidraw board the panel row stays disabled ("Coming soon"). In
spy mode it is disabled too.

While it is on, students and observers on that board follow the tutor's
view: their tab and camera are set so they see at least what the tutor sees. They can't pan, zoom or
switch tabs, and see "Following {name}". They can still draw, if they may edit.

- Stored in the locked layer's `meta.leading` as `{ by: participantId, name }`, or missing when off.
  It stays on until a tutor turns it off, even if the tutor reloads. Any tutor can turn it off.
- The tutor leading sends `viewport` in awareness. Followers find it by `pid`.
- If the tutor leading isn't there (left the class), students can move freely
  and see "Waiting for {name}". They follow again when the tutor comes back.
- Each board has its own: Leading Mode in a breakout room leads only that room. The panel switches
  the Leading Mode of the board the tutor is on.

## PDFs

The **Add to board** dialog (upload button, or dropping a file on the board) takes an image or, for
tutors and admins, a PDF up to 50 MB. For a PDF it shows every page as a thumbnail (drawn when it
scrolls into view) to untick, then a placement:

| Choice | What happens |
|---|---|
| Below the board, locked (default) | Pages stacked under everything already on the board, 800 wide with a 24 gap, in the **locked layer**. |
| Each page on its own tab | A new tab per page (named after the file and page number, after the current tab), the page at the top of it, in the **locked layer**. The tabs carry the PDF's `pdfId`. |
| Where I'm looking, movable | Same stack, starting in the current view, in the main document. |

Pages are drawn and uploaded one at a time, so there is no page limit and memory stays low. The
whole import is one undo step. Cancel stops after the current page; pages already added stay.

Selecting a PDF page shows **Remove whole PDF**, which deletes every page with the same `pdfId` and
the tabs made for it (with everything on them). On a tab made for a PDF, the x offers "Remove only
this tab" or "Remove the whole PDF". Both can be undone.

## Known limits

- Awareness (presence) is not checked by the server. Someone who changes the page's code could send
  a fake `viewport` with the tutor's `pid` and move followers' views. They can't change any board
  content this way.

## Setting up R2 storage

No frontend settings are needed. The backend reads:

| Variable | Value |
|---|---|
| `R2_ACCOUNT_ID` | Your Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | From the R2 API token |
| `R2_SECRET_ACCESS_KEY` | From the R2 API token |
| `R2_BUCKET_NAME` | The bucket's name |
| `R2_ENDPOINT_URL` | Optional. Only for an EU bucket: `https://{accountId}.eu.r2.cloudflarestorage.com` |

Without them, uploads fail with "File storage isn't set up yet."

In the Cloudflare dashboard:

1. **R2 → Create bucket.** Keep it private: don't turn on public access or the r2.dev address.
2. **R2 → Manage API tokens → Create API token.** Permission "Object Read & Write", limited to that
   bucket. Copy the Access Key ID and Secret Access Key; the secret is shown only once.
3. **The bucket → Settings → CORS policy**, so browsers may upload:

   ```json
   [
     {
       "AllowedOrigins": ["https://YOUR-FRONTEND-DOMAIN", "http://localhost:5173"],
       "AllowedMethods": ["GET", "PUT"],
       "AllowedHeaders": ["Content-Type"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

On Render: the backend service → **Environment** → add the variables above → save, which redeploys.
For local work, add the same lines to `backend/.env`.

## Archiving the version 1 boards (start of Phase 1)

Do this once, before anyone uses `VITE_BOARD_ENGINE=tuteria` against a database. Stop the backend
first, so Hocuspocus cannot save an open board back.

Export to a file, not to a new table. A table that Prisma doesn't know about makes
`prisma migrate dev` report drift and offer to reset the database.

```sh
pg_dump "<database url>" --table=public.boards --data-only --file=boards-archive-<date>.sql
psql "<database url>" -c 'DELETE FROM boards;'
```
