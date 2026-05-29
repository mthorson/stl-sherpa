# Architectural decisions

A running log of non-obvious design choices and the reasoning behind them.
Append new entries to the top. Keep each entry short — the goal is to
preserve the *why* so a future reader (or future you) doesn't relitigate
a settled question.

## Format

```markdown
## YYYY-MM-DD — Short title

**Context.** What forced the decision (constraint, bug, failed approach).

**Decision.** What we chose.

**Consequences.** What this makes easy or hard. What it rules out.
```

---

## 2026-05-22 — Print-cost estimate is deliberately rough

**Context.** Added a per-model material-cost estimate (filament + resin)
to the metadata panel. The accurate path — running each STL through a
real slicer to get exact gram counts — would mean shelling out to
PrusaSlicer/Cura per file, parsing G-code, and blocking on a multi-second
operation. That's not a "browse my library" feature; that's its own app.

**Decision.** Compute true mesh volume via signed-tetrahedron sum during
the existing thumbnail render (same triangle walk as the watertight
check, so essentially free), then multiply by hardcoded PLA / resin
densities and a single user-tunable filament fill factor (default 0.30
to cover ~20% infill + walls; resin always 1.0). USD only. Price is
entered as `$X per Y kg` to match how spools and bottles are labeled.

**Consequences.** Numbers are unambiguous and instant but ignore
supports, rafts, brim, non-PLA filaments, and slicer-specific waste.
The "Print cost (rough)" label sets expectations. Anyone needing
accurate numbers should slice the file. The fill-factor knob is the
escape hatch when defaults are off for a given user's print style.

Volume backfill is lazy: older thumbnails don't have
`meshVolumeMm3` in their metadata blob and show "Re-render this
thumbnail to compute…" instead of the cost rows. No migration ran
because `files.metadata_json` is already a JSON blob and the field is
optional.

---

## 2026-05-22 — Build on Electron

**Context.** Initial stack selection. The app needs an interactive 3D
viewer with reasonable PBR, cross-platform desktop distribution, full
filesystem access, the ability to launch external slicers, a polished
browser-style UI for thousands of files, and a local database. No
single platform is ideal for all of these — the question was which set
of trade-offs to take on up front.

**Decision.** Build on Electron. It's the only stack that brings
slicer launching, full filesystem access, and Three.js together in one
process tree, and React + Mantine + Three.js covers the UI and viewer
needs with mature off-the-shelf libraries.

**Consequences.** Accept a ~200 MB bundle, the `better-sqlite3` ABI
rebuild dance for the test runner, unsigned-binary warnings on first
launch until signing is set up, and Chromium's memory footprint. In
exchange we get the React + Mantine UI, the Three.js ecosystem for the
viewer, `chokidar` for filesystem watching, `child_process` for
shelling out to slicers, and `better-sqlite3`'s native perf.

### Alternatives considered

#### Go

- **Pros:** Fast backend; no ABI pain; lower memory.
- **Cons:** No 3D viewer story; thin mesh-library ecosystem; still need
  a webview for the UI anyway; backend-only win for a UI-heavy app.

#### Python

- **Pros:** `trimesh` for mesh analysis; `pyrender` for headless thumbs;
  clean backend libs.
- **Cons:** Weak desktop UI options; worse interactive viewer; still
  need a JS frontend for Three.js.

#### Rust + wgpu / Bevy

- **Pros:** Native PBR rendering; no Chromium overhead; memory safe and
  fast.
- **Cons:** Steep learning curve; immature GUI frameworks; long initial
  build; mesh-loader ecosystem thinner than JS.

#### C++ + Filament + Qt

- **Pros:** Best-in-class PBR; deep 3D library ecosystem; native perf.
- **Cons:** Build complexity; memory unsafe; slow iteration; Qt UI less
  polished than React.

#### Unity

- **Pros:** HDRP visual fidelity; mature asset pipeline; visual lighting
  tools.
- **Cons:** Bad fit for a desktop UI shell; 100–200 MB+ binary; slow
  cold start; licensing risk; no 3MF loader; heavy for thumbnail
  workers.

#### Godot

- **Pros:** Lighter than Unity; permissive license; decent PBR.
- **Cons:** UI shell still awkward; smaller ecosystem; renders below
  HDRP.

#### PWA

- **Pros:** No bundled Chromium; tiny install; auto-updates; no code
  signing; WebGPU rendering; same React/Three.js code.
- **Cons:** No slicer launching; weaker filesystem watching;
  Chromium-only for full features; File System Access API still
  maturing.

---
