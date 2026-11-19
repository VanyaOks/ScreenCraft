# ScreenCraft — screenshot annotations for DSH

> Русская версия: [README.ru.md](README.ru.md)

DSH (DeepSeek Harness) plugin **ScreenCraft** that adds an annotation editor for
screenshots. It adds an **Annotate screenshot** button to the composer tool row.
The editor opens a full-window canvas where a screenshot is pasted (`Ctrl+V`),
dropped, or picked from disk, and marked up with:

- numbered points, rectangles, arrows, and rulers, each with its own color and comment;
- color = purpose: the palette and the right-click menu pick a meaning — error (red),
  fix (yellow), as intended (green), question (blue), important (orange), idea
  (purple), note (cyan), relation (pink); the legend spells out the meaning next to
  the color;
- marker grouping: merge several shapes under one number and one shared comment
  (for example, three arrows that carry one message). Tick the markers in the list
  and press **Merge**; **Ungroup** splits them again;
- numbers stay sequential: deleting a marker renumbers the remaining ones without gaps;
- canvas multi-select: marquee or Shift+click selects several markers, which can be
  moved, deleted, grouped, and duplicated together (Ctrl+D); number badges spread
  out automatically so they do not overlap;
- line styles: solid/dashed, one/two arrow heads, thin/normal/thick, straight/curved
  — for the next marker and for the selected ones (right-click menu);
- the **Hide** tool pixelates a selected area to remove passwords and personal data
  from the screenshot before sending it;
- annotations are saved in the browser per image hash and restored when the same
  screenshot is pasted again;
- keyboard shortcuts: M/P/R/A/L/X pick tools, Delete removes the selection,
  Ctrl+Z / Ctrl+Shift+Z undo/redo, Ctrl+D duplicates, Esc clears the selection;
- mouse-wheel zoom to the cursor, pan with Space or the middle mouse button,
  Shift+wheel scrolls horizontally;
- export as PNG, JPEG, or WebP (picker at the bottom); **Text only** sends the
  coordinates and comments without the image;
- batch annotation: **Add to queue** keeps the current screenshot, the next one can
  be pasted, and all of them are sent in one message;
- a ruler marker for alignment lines: the **Ruler** tool draws a line with end ticks; holding **Shift** while drawing snaps the angle to 10° steps (like Photoshop);
- right-click on the image opens a menu for the marker type and color; right-click
  an existing marker changes its shape and color;
- a pointer tool for moving and deleting existing markers;
- undo/redo, zoom, a fit button, and a marker list with per-marker comments;
- an adaptive layout: for a landscape screenshot the marker panel moves below the
  image, which gets the full width; for a portrait one it stays on the right. The
  marker panel can be collapsed;
- on open the screenshot is fitted to the stage so the whole image is visible
  without scrolling: a landscape one fits both sides (the marker panel below
  starts collapsed), a portrait one fits the width;
- uniform empty margins around the content (desktop wallpaper, empty canvas) are
  trimmed on paste, while **Restore** brings the original frame back; the **Crop**
  tool cuts a region manually.

## Installation

The repository is the finished bundle — there is no build step. Install it into
a DSH profile from GitHub:

1. Open the DSH Web UI → **Settings → Plugins**.
2. Install a bundle from the URL `https://github.com/VanyaOks/Screenshot`.
   In a DSH session you can also ask the agent to install that URL.
3. Refresh the page. The annotate button appears in the composer tool row.

After installation the plugin works in every session of that profile.

On **Insert into chat** the browser exports a PNG scaled for token economy, the
Host half saves it under `<workspace>/.dsh/annotations/`, and a compact legend is
inserted into the composer together with the workspace-relative path, for
example:

```
Annotated screenshot: .dsh/annotations/annotation-20261114-125501-ab12.png (1024×576) — read the image with read_image.
Markers (coordinates are % of width×height):
#1 red rectangle 12–40% × 5–18%: the button is too close to the edge
#2 blue point 55%,30%: wrong label here
```

Review the inserted text and press Send. The agent receives the annotation image
and the exact marker coordinates, and can read the file with `read_image`.

## Why a file instead of an attachment

Adding an image as a draft attachment requires private composer APIs that are not
part of the plugin surface. The Host route plus a workspace file is the stable
path: it never touches another plugin's slots or DOM, and the agent reads the
image through its own file tools. If a file save ever fails, the plugin downloads
the PNG and copies the legend, so the work is never lost.

## Token economy

The export long edge is selectable — 768 px (default), 1024 px, 1536 px, or the
original size — and the editor shows the estimated image tokens for the current
choice. Only one image plus the compact marker legend is sent.

## Where files go

`<workspace>/.dsh/annotations/` with generated filenames. Older files are pruned
beyond the newest 200 or after a week. Screenshots may contain secrets: nothing
leaves the machine except the image the agent reads through its own tooling, and
the route only accepts same-origin POST requests from the local page.

## Scope

- Annotate **before** sending: paste or drop the screenshot into the editor.
- A screenshot already sent in the conversation can be dragged from the chat back
  into the composer and then opened in the editor.
- The color mapping is a convention, not enforced: red = broken, yellow = fix,
  green = as intended, blue = question.
