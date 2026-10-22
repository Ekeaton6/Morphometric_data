# Cichlid Morphometric Annotator (v0.5)

## Run on the laptop
Double-click `start.command`, or in Terminal:

```
cd ~/Desktop/fish_annotator
./start.command
```
The first run creates a `.venv` and installs the packages. Then open http://localhost:8024 (`./start.command --port 9000` for another port).
Stop it with Ctrl+C in the Terminal window.

## Files
| File | Purpose |
|---|---|
| `config.json` | Image folder, metadata spreadsheet, column names, host/port |
| `landmarks.json` | Landmark set: IDs, names, groups, colors, and positions on the reference image (these give the starting guesses). **Bump `version` when you change it.** |
| `colorchart.json` | 24-patch chart layout and reference sRGB values (standard ColorChecker values; check them against the Pixel Perfect spec) |
| `static/reference.png` | Reference image shown under the landmark tab |
| `data/annotations.db` | SQLite database with all annotations and their history |
| `data/annotations/*.json` | One readable JSON sidecar per image, rewritten on every save |
| `data/cache/` | Thumbnails and rotated display images. Safe to delete. |

## Workflow
1. **Landing page**: images grouped by Species, each with a status: Not started, In progress (saved), Annotated (submitted), or Approved.
2. **Tab 1**
   - **Chart:** click the centers of the corner patches 1 → 6 → 24 → 19. The other 20 patches are placed automatically, and you can drag any patch to adjust it. The app records the median RGB and Lab of a small square in each patch.
   - **Ruler:** click two marks and enter the distance between them (default 10 mm) to get px/mm.
   - **Fish box:** click the snout tip, then the tail tip. Drag the edges to resize, drag the ⟳ handle to rotate (hold Shift to snap to 5°), and drag ✥ to move.
3. **Tab 2**: the fish is shown straightened, with its head on the left and dorsal side up. Starting guesses come from the template; drag each point into place. A dashed ring means the point hasn't been moved yet.
   - Keys: Tab / Shift+Tab = next / previous point, arrows = nudge (Shift = 10 px), X = mark absent, F = fit to window.
   - **← Previous / Next →** in the top bar (or Alt+← / Alt+→) step through images in list order, saving first. **Next unannotated** skips to the next image not yet done.
4. **Save** (it also autosaves 4 s after each change) → **Mark annotated** → someone else clicks **Approve**. Approved records are locked; **Reopen** removes the approval and logs it in the history.

## Automatic guesses (v0.2)
When an image opens, the chart, ruler and fish box are pre-filled by `detect.py` (needs numpy + opencv; `start.command` installs them).
Each guess shows a yellow "Auto-detected, check it" note. Adjusting it or clicking **Looks right** turns the note green, and
"Mark annotated" warns about guesses nobody has checked. The wide CSV records whether each item was
`manual`, `auto-confirmed`, `auto-adjusted` or `auto-unchecked`.
- **Chart:** it finds the 24-patch grid and works out its orientation by matching the patch colors to the ColorChecker layout.
- **Ruler:** it finds the mm tick row using the chart as a size cue and snaps both ends to cm lines, using the full 0–15 cm when visible.
  If it can't confirm the cm lines, the note says the endpoints may be about 1 mm off.
- **Fish:** it takes the biggest fish-shaped object within about 7 cm of the ruler and assumes the head is on the left. If nothing fits, the box is left for you to draw.
- X-rays (no chart) get no guesses.
- Guesses for not-yet-annotated images are computed in the background after the server starts (about 2–3 s per image) and cached in `data/detect/`.
  **Re-run auto-detect** on tab 1 recomputes them for the current image.

## Coordinates in exports
- `x, y`: pixels in the full-resolution image after applying the phone's EXIF rotation, origin at top-left.
- `u, v`: fish-frame pixels. `u` runs from the head edge of the fish box toward the tail; `v` runs from the dorsal edge toward the ventral edge.
- `*_mm`: the value divided by px/mm from the ruler.
- **TPS export**: fish-frame coordinates with y pointing up. `SCALE` = mm per pixel. Absent points are written as `-1 -1`; read them with `geomorph::readland.tps(file, specID = "ID", negNA = TRUE)`.
- **Sliders (geomorph)**: semilandmark definition for points 8–15. Use it like this:
  ```r
  lm  <- readland.tps("landmarks_all_annotated_DATE.tps", specID = "ID", negNA = TRUE)
  sl  <- as.matrix(read.csv("sliders_cichlid_lateral_demo@0.4.csv"))
  gpa <- gpagen(lm, curves = sl, ProcD = FALSE)   # bending energy sliding
  ```

## Landmark set v0.4 (24 points)
1–7 are fixed landmarks; 8–15 are equidistant semilandmarks on the craniofacial slope between 7 and 4; 16–24 are the remaining body points
(see `static/reference_v04.png`). On Tab 2, moving any of 8–15 (or 7 or 4) re-spaces 8–15 evenly along a smooth outline through
them. You can turn this off with the "Keep 8–15 evenly spaced" checkbox.
Annotations saved with an older version are renumbered automatically the first time the server starts. The database is backed up first
to `data/annotations_backup_before_…db`. The renumbering is old 1→7, 2→1, 3→2, 4→3, 5→16, 6→17, 8→4, 9→18, 10→19, 11→20, 12→21, 13→22,
14→23, 16→24, 17→6, 18→5; old 7 (nape) and 15 (pectoral) are dropped. Those images go back to "In progress" because 8–15 still need placing.

## Starting-guess template
The first guesses come from the reference image. Once some images are annotated, click **Recompute from annotated images** on the landing page to average the real annotations; this needs at least 3 images.

## Running on the Linux PC (/home/student/Desktop)
`config.json` uses relative paths (`../Digital_Phenotype`, `../Digital_Phenotype_Info.xlsx`), so no edits are needed
as long as the PC's Desktop holds the same three items:
```
/home/student/Desktop/fish_annotator/            <- unzip fish_annotator_for_PC.zip here
/home/student/Desktop/Digital_Phenotype/         <- copy the whole image folder (keep the subfolders)
/home/student/Desktop/Digital_Phenotype_Info.xlsx
```
Then in a terminal:
```
cd /home/student/Desktop/fish_annotator
./start.sh
```
`start.sh` creates its own `.venv-linux` and installs the packages (it needs internet the first time).
If it says it can't create a virtual environment: `sudo apt install python3-venv python3-pip`.
The `data/` folder holds all annotations, so always move it together with the app, and stop the server before copying it.

## Running on a shared server (SSH tunnel), recommended for several annotators
The server listens only on the server itself (`127.0.0.1`), so it is not exposed to the network; each user reaches it
through an SSH tunnel. There are no passwords in the app (initials only), so keep it that way.

**On the server (once):**
```
cd /path/to/fish_annotator          # with Digital_Phenotype/ and Digital_Phenotype_Info.xlsx next to it
bash start.sh                       # default port 8024
bash start.sh --port 9000           # or any free port (also: FA_PORT=9000 bash start.sh)
bash start.sh --images /data/Digital_Phenotype --metadata /data/Digital_Phenotype_Info.xlsx   # if they live elsewhere
```
On startup it prints the exact tunnel command. To keep it running after you log out, start it inside `tmux`
(`tmux new -s fish`, run `bash start.sh`, detach with Ctrl+B then D; reattach with `tmux attach -t fish`), or:
`nohup bash start.sh > annotator.log 2>&1 &`.

**On each user's own computer (every session):**
```
ssh -N -L 8024:localhost:8024 USERNAME@SERVER
```
Leave that terminal open and browse to http://localhost:8024. If 8024 is busy on the laptop, use another local
port: `ssh -N -L 9024:localhost:8024 USERNAME@SERVER`, then http://localhost:9024. (Windows: the same command works
in PowerShell.)

**Several people at once:**
- The landing page shows "open by EK" next to images someone has open.
- An image page shows a yellow bar when someone else has the same image open.
- If someone else saves an image after you opened it, your save is refused and you choose: load their version, or keep
  yours (overwrites theirs; recorded in the history). A red bar also appears if they save while you're just viewing.

## Moving to the lab server
1. Copy this folder to the server.
2. Edit `config.json`:
   - set `image_dir` and `metadata_file` to the server paths;
   - set `"host": "0.0.0.0"` so other machines can connect.
3. Run `python3 server.py`.

Annotators are identified by initials only, so keep the server on the lab network or VPN.
