# Level Proto 2D Metroidvania — Documentation

## Overview

This package lets you block out 2D metroidvania levels using editable polygon shapes (`ProtoShape2D`) instead of individually placed and resized cube sprites, with area `ProtoLabel2D` labels and a data-driven PNG exporter.

## Demo scene

Open `Demo/Level Proto 2D - Material Showcase.unity` to see Proto Grid, Cavern Stone, and Mossy Ruins side by side in a playable level. The scene contains representative floors, floating platforms, slopes, masonry steps, `ProtoShapeGroup` organization, `ProtoLabel2D` labels, and a configured Proto Player. The lightweight Solid style is available directly from any shape's Visual Style menu.

- Move with `A` / `D` or the left/right arrow keys.
- Jump with `Space`.
- The demo remains outside Build Settings until you explicitly add it.

## Core concepts

### ProtoShape2D

A polygon shape (local-space vertex list) that drives a generated `Mesh` and, optionally, a `PolygonCollider2D`. Select a shape in the Hierarchy to edit it directly in the Scene View:

- Drag a vertex to move it.
- Click a vertex to keep it selected and open the floating Vertex Inspector, where its local position can
  be edited numerically and the previous/next vertex can be selected.
- In the Vertex Inspector, change **Tangent** from **Linear** to **Continuous** for a smooth Bezier corner
  with aligned handles, or **Broken** to control the incoming and outgoing handles independently. Linear
  is the default and shows no tangent handles.
- Drag an edge to move both its vertices together.
- Click an edge (without dragging) to insert a new vertex at that point.
- Remove the selected vertex from the floating inspector or with Delete (a shape always keeps at least
  three vertices).
- Toggle Extrude Edge mode in the Inspector to grow the shape from an edge.

Curves are tessellated into the same evaluated outline used by the generated mesh, collider, procedural
material boundary, and PNG export. JSON format version 4 preserves the original control points, tangent
modes, tangent offsets, outline settings, and inner-shadow settings.

### Snapping

Grid snap and axis-angle snap are on by default and combine so that near-horizontal/vertical edges stay perfectly level, and vertices land on the current Scene View grid. Change **Grid Size** in Unity's **Grid and Snap** overlay to control the snapping interval. Hold the bypass modifier while dragging to disable snapping temporarily.

### Runtime visual materials

Shapes use `ProtoGridUnlit.shader` by default, which draws grid lines from world-space position so adjacent shapes' grids align seamlessly — this is what gives visual movement feedback in Play Mode over large flat areas.

The **Visual Style** control in the `ProtoShape2D` Inspector offers four bundled styles:

- **Solid**: a simple, texture-free fill driven only by **Fill Color**.
- **Cavern Stone**: layered rock, surface grain, and irregular cracks.
- **Mossy Ruins**: offset masonry blocks with chipped edges and procedural moss patches.
- **Proto Grid**: the original world-space blockout grid and ruler ticks.

All bundled styles work with both URP renderers shipped by the package and use the shape's **Fill Color**. Their shared **Outline** group has an explicit enable checkbox, solid-black default color, and per-shape thickness. The shared **Inner Shadow** group has Color, Blend Mode (Multiply by default), Choke, and Size controls. These effects follow the shape's real polygon boundary and are reproduced by PNG export. The Material field directly below the preset control still accepts any custom URP material; custom materials do not receive the bundled outline or inner-shadow effects.

### ProtoLabel2D

A text label component for naming areas (e.g. "Boss Arena", "Water Temple Entrance"). Visible in the Scene View and included in PNG exports.

### PNG export

`Tools > Level Proto > Export PNG` rasterizes every `ProtoShape2D` and `ProtoLabel2D` in the active scene directly from their data (not a camera screenshot), sized by the Pixels Per Unit you configure.

## Settings

Project defaults (export PPU, default fill color, snap tolerance, and ruler color) live in a `ProtoShapeSettings` asset at `Assets/Settings/ProtoLevelSettings.asset`, created automatically on first use. Grid size is controlled by Unity's Scene View **Grid and Snap** overlay.
