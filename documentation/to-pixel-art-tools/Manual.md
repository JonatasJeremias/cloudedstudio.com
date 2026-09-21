# To Pixel Art Tools — Manual

- [1. Installation and requirements](#1-installation-and-requirements)
- [2. The conversion window](#2-the-conversion-window)
- [3. How the pipeline works](#3-how-the-pipeline-works)
- [4. Stage reference](#4-stage-reference)
- [5. Animations](#5-animations)
- [3D model sources](#3d-model-sources)
- [6. Batch conversion](#6-batch-conversion)
- [7. Profiles](#7-profiles)
- [8. Palettes](#8-palettes)
- [9. Output and import settings](#9-output-and-import-settings)
- [10. Scripting API](#10-scripting-api)
- [11. Performance](#11-performance)
- [12. Troubleshooting](#12-troubleshooting)

---

## 1. Installation and requirements

Import the package. Everything lives under `Assets/CloudedStudio/ToPixelArtTools` and you can move or
rename that folder freely — the tool locates its own files at runtime.

**Requirements:** Unity 6 (6000.x) or newer. Nothing else. There are no package dependencies, no
native plugins, no external executables and no network access.

The package is split into two assemblies:

| Assembly | Contents |
| --- | --- |
| `CloudedStudio.ToPixelArtTools` | The conversion pipeline, settings, profiles and palettes. Included in builds. |
| `CloudedStudio.ToPixelArtTools.Editor` | The window, inspectors, batch tools and exporters. Editor only. |

If you never call the API from your own code, the runtime assembly costs you a few kilobytes and
nothing else. Unity strips it from builds that do not reference it.

---

## 2. The conversion window

**Window ▸ Clouded Studio ▸ To Pixel Art Tools ▸ Convert to Pixel Art**

The left side holds the settings, the right side the live preview.

The **Source** field keeps the existing project-asset workflow. To use an original that should not be
imported, choose **Open External Image…** or drag a PNG, JPG, or JPEG from the file system. The tool
reads it directly and keeps only the converted output in `Assets`. Numbered external files use the
same automatic sequence detection as project assets.

### Preview controls

| Action | How |
| --- | --- |
| Zoom | Mouse wheel over the preview, or the `−` / `+` buttons |
| Pan | Middle mouse drag, or Alt + left drag |
| Fit to window | **Fit** |
| Actual size | **1:1** |
| Compare before and after | Set the view mode to **Compare**, then drag the white divider |
| Pixel grid | **Grid**, shown once you are zoomed in past 8× |
| Scale reference | **Scale Reference ▸ Choose Image…**, then drag the overlay around |

The **Scale Reference** overlay exists for one question that comes up constantly: *is this the right
resolution for my game?* Drop in a character sprite you already have and compare directly.

### Live preview

The preview reconverts automatically a fraction of a second after you stop changing something. The
conversion runs on a background thread and is cancelled as soon as another change arrives, so
dragging a slider stays smooth even on large images.

Turn **Live Preview** off in the toolbar if you are working with a big animation, and use **Refresh**
to convert on demand instead.

### The information bar

Underneath the preview:

```
128 × 128 px  ·  factor 4×  ·  palette 32  ·  41 colours in output  ·  86 ms
```

**Palette** is the number of colours the quantizer produced. **Colours in output** is what the final
image actually contains. They differ when a stage placed *after* Pixel Art blends new colours in —
Outline and Diffuse both do. If you need the palette to be exact, move those stages above Pixel Art
in the pipeline list, or turn them off.

---

## 3. How the pipeline works

A conversion is a list of stages, run top to bottom. You can drag them into any order, and the order
matters more than it first appears.

**Pixel Art is the pivot.** Everything above it works on the full resolution source; everything below
it works on the finished, low resolution grid where every pixel is precious.

Some consequences worth internalising:

- **Smooth belongs above.** Its job is to stop noise from being baked into pixels. Below Pixel Art it
  just blurs the result.
- **Despeckle belongs below.** A stray pixel only exists once the grid exists.
- **Island Removal belongs below.** Its size is measured in output pixels, so placing it after Pixel
  Art removes the small fragments created by downscaling.
- **Outline works either way.** Above Pixel Art it is drawn at full resolution and then reduced, which
  gives a softer, thinner line. Below, it is drawn directly onto the grid and is exactly the thickness
  you asked for.
- **Diffuse changes character completely.** Above Pixel Art it is a painting effect on the source.
  Below it, it scatters your finished pixels — occasionally the effect you want, usually not.
- **Background Removal is almost always above.** Removing a background at full resolution gives the
  edge peeling far more material to work with.
- **Color Removal usually belongs above.** Select colours from the source before quantization changes
  them, unless the intention is specifically to remove a colour from the final palette.

The *Painted* preset is a worked example: it moves Diffuse above Pixel Art on purpose.

---

## 4. Stage reference

### Smooth

Noise reduction that preserves edges, applied to the colour channels only. Alpha is never touched.

| Setting | Notes |
| --- | --- |
| **Bilateral** | Averages neighbours weighted by both distance and colour similarity. A neighbour across a strong edge contributes almost nothing, so noise disappears while edges stay put. |
| Sigma Color | How different two colours may be and still be averaged. Higher smooths across stronger changes. |
| Sigma Spatial | Radius of influence. Cost grows with the square of this value — 3 is a good default, 10 is slow on large images. |
| **Total Variation** | Minimises total change across the image. Produces flat plateaus separated by sharp steps, which suits pixel art well. |
| Weight | Higher gives broader, flatter blocks. |

### Background Removal

Turns a flat background colour into transparency, in two passes.

1. **Tolerance** — a conservative sweep across the whole image. Everything within this distance of the
   key colour becomes transparent.
2. **Edge Tolerance** and **Edge Passes** — a much more permissive sweep that only ever touches pixels
   *adjacent to background that was already removed*, peeling one layer per pass.

The split is the whole point. A single permissive threshold cannot tell the difference between the
background and a light area inside your subject, so it eats both. The second pass can be aggressive
precisely because an enclosed area never touches the outside and is therefore unreachable.

Typical starting values: tolerance 25, edge tolerance 80, 3 passes. If a halo remains, raise the
passes before raising the tolerance.

### Color Removal

Turns pixels matching any selected colour into full transparency. Use **Add Color** as many times as
needed; every swatch participates in the same pass, and **Remove** deletes only that entry.

**Tolerance** is measured as the largest difference on any RGB channel, from 0 to 255. At 0 only
exact matches disappear. A tolerance of 10 accepts pixels whose red, green and blue channels are each
no more than 10 away from at least one selected colour. Alpha on the selected swatches is ignored.

Keep this stage above Pixel Art when sampling colours from the original image. Move it below Pixel Art
when the intention is to remove one or more colours produced by quantization.

### Pixel Art

**Downscale**

| Method | Use when |
| --- | --- |
| Nearest | Art with clean shapes. Keeps edges perfectly hard. |
| Box | Heavy anti aliasing or fine detail, where nearest would sample noise. |
| LAB Average | Same as Box but mixes colour perceptually. Blue and yellow average to green rather than to mud. |

**Factor** is how many source pixels become one output pixel. **Automatic Factor** measures how wide
the image's existing runs of identical colour are; if the source has no block structure at all, it
falls back to whatever lands the longest side near 256 pixels. It is a starting point, not an answer —
adjust it.

**Quantization**

| Method | Notes |
| --- | --- |
| K-Means | Clusters colours perceptually. Best quality, and the default. Deterministic: the same seed always gives the same palette. |
| Median Cut | The classic fast algorithm. Splits along RGB axes, so it can spend entries on wide but unimportant gradients. |
| Fixed Palette | Maps onto a palette asset you supply. Guarantees consistency across every asset that uses it. |

**Palette Seed** changes which equally valid palette you get. If two or three colours are landing
somewhere you dislike, nudging the seed is often faster than fighting the colour count.

**Ignore Transparent Pixels** leaves fully transparent pixels out of palette building. The colour
stored underneath a transparent pixel is arbitrary and would otherwise consume entries you never see.
Leave it on unless you have a specific reason.

**Dither** spreads the quantization error so a small palette can suggest colours it does not actually
contain. Without it, a gradient mapped onto twelve colours becomes twelve hard bands; with it, the
boundary between two palette colours becomes a mix of both and reads as smooth from a normal viewing
distance.

| Method | Character |
| --- | --- |
| Floyd–Steinberg | Error diffusion. Organic, irregular texture that follows the image. The closest match to the original, and the best choice for a still image. |
| Ordered 2×2 | Very coarse, strongly visible pattern. |
| Ordered 4×4 | The classic retro cross hatch. A good default when you want the dithering to read as a deliberate style. |
| Ordered 8×8 | The finest, smoothest ordered pattern. |

**Dither Strength** scales how much error is spread. Below 1 keeps the pattern subtle while still
breaking up the worst banding, which usually suits artwork better than full strength does.

Two things worth knowing:

- **Dithering and clean up stages cancel each other out.** Dithering works by placing isolated,
  alternating pixels — which is exactly what **Merge Runs** and **Despeckle** exist to remove. Use one
  or the other. The window warns you when both are on.
- **For animations, prefer an ordered method.** Ordered patterns depend only on pixel position, so
  they are identical from frame to frame. Error diffusion depends on the whole image, so a small
  change between frames reshuffles the noise and the pattern visibly crawls during playback.

Both methods measure error perceptually, and the ordered methods nudge each pixel *along the direction
of its own quantization error* rather than along a fixed axis — so they dither correctly across
boundaries between colours that differ in hue, not only in brightness.

**Merge Runs** sweeps rows and then columns, collapsing sequences of near identical colours into one
flat colour. This is the automated version of the clean up an artist does by hand, and it is what
makes a converted image look deliberate rather than sampled. Tolerance is measured perceptually: about
2 is the threshold of human vision, 8–12 merges what already looks the same, 15–25 deliberately
flattens shading into bands.

**Color Transfer** applies the tone, saturation and contrast of any reference image to the result. The
two images need nothing in common. Because the transfer produces a continuous gradient, the image is
re-quantized afterwards to bring it back to a pixel art palette.

**Alpha Threshold** forces alpha to be fully transparent or fully opaque. Anti aliasing leaves a rim of
partially transparent pixels that is invisible at full resolution but becomes a row of washed out
pixels on a grid — and a visible seam wherever the sprite is drawn over a different background. Set to
0 to keep the original alpha.

**Sharpen** applies a light sharpening kernel to the colour channels. Useful after Box or LAB Average
downscaling. Alpha is excluded deliberately, so it cannot undo the alpha threshold.

### Despeckle

Removes connected regions smaller than **Minimum Region Size**, repainting them with the dominant
colour around them. Regions of transparency count too.

This catches what Merge Runs structurally cannot: a single misplaced pixel forms no run in either
direction, so a row and column sweep always leaves it behind — and it is exactly the kind of speck
that makes an image read as noisy.

### Island Removal

Deletes foreground components containing **Maximum Island Size** pixels or fewer when they are
disconnected from the rest of the image by transparency. For example, a maximum of 3 removes islands
of 1, 2 or 3 pixels and preserves every component containing 4 pixels or more.

Connectivity uses all eight neighbours, so pixels touching diagonally belong to the same island.
**Transparency Threshold** controls the classification: alpha below the threshold counts as
transparent while components are found. It does not otherwise change partially transparent pixels;
use Pixel Art's **Alpha Threshold** as well when the output itself should have hard alpha edges.

Keep the stage below Pixel Art to measure components on the final grid. It is independent from
Despeckle: Island Removal changes small components to transparency, while Despeckle repaints small
same-colour regions with a neighbouring colour.

### Outline

Darkens the boundary between distinct colour regions and around the silhouette.

**Minimum Contrast** is the setting that decides whether this looks good. Too low and the outline
traces every small step the quantizer left behind, turning the sprite into a wireframe. Around 90 is a
good starting point for sprites; at 255 only the silhouette is drawn.

The image border is never treated as an edge, so a full bleed background does not come back with a
frame drawn around it.

### Diffuse

| Mode | What it does |
| --- | --- |
| Anisotropic | Blends the four quadrants around each pixel weighted by how uniform each one is. Edges survive, flat areas are cleanly averaged — an oil painting effect. |
| Random / Darken / Lighten | Replace each pixel with a random neighbour, optionally only when that neighbour is darker or lighter. Breaks up mechanical edges and adds grain. |

**Sharpness** (anisotropic only) controls how much the most uniform quadrant dominates. Low values
around 0.2–0.4 blend generously for a soft painted edge; 8 and above give hard, poster like
boundaries.

The scattering modes use a **Seed** so results are reproducible. Turn **Fixed Seed** off for a
different scatter every run.

---

## 5. Animations

If your file name ends in a number — `walk_001.png`, `walk01.png`, `walk-1.png`, `frame1.png` — the
other frames beside it are detected automatically and an **Animation Sequence** checkbox appears.

With it on, every frame is converted together against **one shared palette**. This is not a
convenience: quantizing frames independently lets each shade drift by a step or two between frames,
which is invisible in a still comparison and impossible to miss once the animation plays.

Use the timeline under the preview to scrub or play back at a chosen frame rate. **Convert and Save**
writes every frame.

### 3D model sources

Choose **Model 3D** in the Source card, then select or drag a model, model prefab, or regular prefab
from the Project window. You can also use **Open External Model...**, or drag an external FBX, OBJ,
GLB, or GLTF file from the operating system. External files must become Unity assets before they can
be rendered, so the tool asks where to create the imported copy inside `Assets`. The original file is
never modified.

For textual GLTF, local buffer and image URIs are copied while preserving their relative paths. OBJ
material libraries and their locally referenced textures are copied in the same way. Embedded GLB
data needs no sidecar copy. Existing dependency files at the chosen destination are preserved and
reported instead of being overwritten.

The **3D Capture** section controls raster resolution, orthographic or perspective projection,
framing, camera orbit, zoom, and base model rotation. The **3D Lighting** section controls the
background, ambient light, and two directional lights. Transparent capture uses black and white
mattes to reconstruct straight alpha consistently across render pipelines.

Use the preview dropdown to switch between **Model 3D**, the rendered source, the converted result,
or the before/after comparison. Drag inside Model 3D to orbit the camera and use the mouse wheel to
zoom. Camera changes recapture the model; pipeline-only changes reuse the current capture.

The **3D Sequence** section supports:

- **Still** — one model pose and one output image.
- **Turntable** — evenly spaced rotation frames around the selected local axis.
- **AnimationClip** — choose from the usable clips embedded in or assigned to the selected model, then
  sample frames over a normalized clip range. **Frame Count Mode** offers **Manual**, where **Frames**
  remains editable up to the clip's original sample count; **Source Frame Count**, which captures the
  original duration × frame rate count; and **Match Preview FPS**, which calculates the output count
  from the sampled Start/End duration × the FPS selected under the preview. For example, a 40-frame
  clip at 24 FPS produces 20 frames when preview playback is set to 12 FPS, preserving its duration.
  Automatic modes disable **Frames**, and Match Preview FPS recalculates when FPS, Start, or End
  changes. **Animation Framing** defaults to **Fixed Model Frame**,
  which preserves the same center and scale when changing clips; adjust **Framing** or **Zoom** once to
  leave room for the widest movement. **Auto Fit Clip** instead measures the combined deformed bounds
  of the selected clip to avoid cropping, but different clips can render at different scales. Leave
  **Include End** disabled for looping clips so the first pose is not duplicated at the end.

All sequence frames are processed together so palette generation is stable across the animation.
Export them as numbered PNG files, or as an exact-grid atlas. Atlas output is imported as a default
texture and includes a neighboring JSON manifest containing columns, rows, padding, frame dimensions,
source GUID, and AnimationClip GUID when applicable.

FBX and OBJ use Unity's normal model importers. GLB/GLTF is accepted when the consuming project has a
compatible importer package installed. To keep the feature package-agnostic, To Pixel Art Tools does
not install or reference a specific GLTF implementation. If no compatible importer produces a
GameObject, the operation reports the missing support and removes the files it created.

---

## 6. Batch conversion

Select any number of images or folders in the Project window, then
**Clouded Studio ▸ To Pixel Art Tools ▸ Batch Convert…**, or use the same entry in the main menu.
In the batch window you can also add external PNG/JPG/JPEG files or folders, or drag several external
sources in at once. Project and external images can be mixed in one run.

Pick a profile, decide whether to **Share One Palette** across the whole selection, and convert. The
progress bar is cancellable and reports anything that failed rather than stopping at the first error.
When **Save Next to Source** is enabled, it applies only to project assets. External results always use
the configured destination inside `Assets`; the originals are never copied or imported.

Sharing one palette is worth considering for tilesets, icon sets and anything else that is seen
together. Converted image by image, they end up with colours that almost match — which reads as sloppy
in a way that is hard to name but easy to see.

The **More** menu in the conversion window batches the current selection using the settings you are
looking at, which is convenient once you have dialled them in.

---

## 7. Profiles

A profile is an asset holding a complete set of conversion settings plus the palette and reference
image they use.

- **Create:** the **Save As…** button in the window, or
  **Assets ▸ Create ▸ Clouded Studio ▸ To Pixel Art Tools ▸ Pixel Art Profile**.
- **Preset profiles:** **Window ▸ Clouded Studio ▸ To Pixel Art Tools ▸ Create Preset Profiles**
  writes one asset per built in preset. Presets are also available directly from the **Presets**
  toolbar menu without creating any files.
- **JSON:** import and export from the window's **More** menu or from the profile inspector, for
  sharing setups across projects.

Profiles are plain assets, so they diff and merge in version control like anything else.

---

## 8. Palettes

**Assets ▸ Create ▸ Clouded Studio ▸ To Pixel Art Tools ▸ Color Palette**

The palette inspector can:

- **Import** `.hex`, `.txt` and GIMP `.gpl` files. Blank lines and comments are ignored, so a file
  mixing notes with colours still loads.
- **Export** as a plain hexadecimal list.
- **Extract from an image** by clustering its colours — the usual way an artist gets a palette is by
  pointing at art they like.
- **Sort by hue or luminance**, which makes a large palette far easier to read.

Right-clicking an image in the Project window offers **Create Palette from Image** directly.

To use a palette, set **Quantization** to *Fixed Palette* and assign it.

---

## 9. Output and import settings

By default the result is written next to the source with a `_PixelArt` suffix, and **Overwrite
Existing** is off — re-running a conversion while dialling in settings is normal, and silently
replacing a result that prefabs and scenes may already reference is not a sensible default.

Writing over the source image is blocked outright.

**Apply Import Settings** configures the written texture the way pixel art needs:

| Setting | Value | Why |
| --- | --- | --- |
| Filter Mode | Point | Anything else blurs the pixels you just created. |
| Compression | Uncompressed | Block compression mottles flat colour areas. |
| Mip Maps | Off | 2D art is drawn at a fixed scale. |
| Non-Power-of-2 | None | Rescaling on import would destroy the pixel grid. |
| Max Size | Large enough for the result | Prevents the importer from shrinking the image. |
| Alpha Is Transparency | On | Correct filtering around transparent edges. |

Turn on **Import as Sprite** to set the texture type and pixels per unit at the same time.

---

## 10. Scripting API

Namespace: `CloudedStudio.ToPixelArtTools`

### Converting textures

```csharp
// With a profile asset.
Texture2D result = PixelArtConverter.Convert(source, profile);

// With settings built in code.
var settings = new PixelArtPipelineSettings();
settings.PixelArt.ColorCount = 24;
settings.PixelArt.AutomaticFactor = false;
settings.PixelArt.Factor = 4;
settings.ColorRemoval.Enabled = true;
settings.ColorRemoval.Colors.Add(new Rgba32(255, 255, 255));
settings.ColorRemoval.Tolerance = 12f;
settings.Despeckle.Enabled = true;
settings.IslandRemoval.Enabled = true;
settings.IslandRemoval.MaximumIslandSize = 3;
Texture2D result = PixelArtConverter.Convert(source, settings);

// Starting from a preset.
var settings = PixelArtPresets.CreateByName("Photo to Pixel Art");

// Frames sharing one palette.
Texture2D[] frames = PixelArtConverter.ConvertSequence(sourceFrames, settings);

// Off the main thread, with progress and cancellation.
Texture2D result = await PixelArtConverter.ConvertAsync(
    source, settings, resources: null, progress: myProgress, cancellationToken: token);
```

`Convert` returns a new texture that **you own** — destroy it when you are done with it.

### Working with buffers directly

`PixelBuffer` is a plain RGBA32 byte buffer with no engine dependency, which is what makes the
pipeline safe to run on a background thread.

```csharp
PixelBuffer buffer = TextureConverter.ToPixelBuffer(sourceTexture);
PixelArtConversionResult result = PixelArtPipeline.ProcessDetailed(buffer, settings);

Debug.Log($"factor {result.DownscaleFactor}, palette {result.Palette.Count}");
Texture2D texture = TextureConverter.ToTexture2D(result.Frame);
byte[] png = TextureConverter.EncodeToPng(result.Frame);
```

### Palettes

```csharp
var palette = new ColorPalette(new[] { new Rgba32(0, 0, 0), new Rgba32(255, 255, 255) });

var resources = new PixelArtPipelineResources { FixedPalette = palette };
settings.PixelArt.Quantization = QuantizationMethod.FixedPalette;

Texture2D result = PixelArtConverter.Convert(source, settings, resources);
```

Set `PixelArtPipelineResources.PrecomputedPalette` instead to force a palette regardless of the
quantization method — that is how batch conversion shares one palette across many images.

### Determinism

Given the same input and settings, the pipeline always produces byte identical output, on every
platform and regardless of how many threads it used. Nothing depends on `UnityEngine.Random`,
`System.Random` or wall clock time. The only exception is Diffuse with **Fixed Seed** turned off,
which is opt in.

---

## 11. Performance

Rough figures for a 512 × 512 source on a modern desktop CPU, reducing by 4×:

| Configuration | Time |
| --- | --- |
| Pixel Art only, K-Means 32 colours | around 40 ms |
| Plus bilateral smoothing (sigma spatial 2) | around 120 ms |
| Plus total variation smoothing | around 600 ms |

Notes:

- **Smooth is the expensive stage**, and it is the only one that runs at full source resolution by
  default. Bilateral cost grows with the square of Sigma Spatial.
- Everything after the resolution drop operates on a much smaller image and is effectively free.
- Row parallel work is spread across CPU cores automatically, and falls back to a single thread on
  platforms without threads (WebGL). Results are identical either way.
- Palette building clusters the *distinct colours* of an image weighted by how often they occur, not
  the individual pixels. This is mathematically identical to clustering every pixel and dramatically
  faster.

---

## 12. Troubleshooting

**The result has more colours than my colour count.**
A stage after Pixel Art is blending new colours in — Outline and Diffuse both do. Move them above
Pixel Art in the pipeline list, or turn them off. The information bar shows both numbers.

**I turned on dithering but the pattern is gone.**
**Merge Runs** or **Despeckle** removed it. Both exist to delete isolated pixels, and the dither
pattern is made of isolated pixels. Turn them off.

**The dither pattern crawls when my animation plays.**
Switch from Floyd–Steinberg to one of the ordered methods. Error diffusion depends on the whole image,
so any small change between frames reshuffles the noise; ordered patterns depend only on position and
stay locked in place.

**I see banding in a gradient.**
That is the palette running out of colours. Raise **Colors**, or turn on **Dither** to trade the bands
for texture — which is often the better trade at low colour counts.

**The output looks noisy and speckled.**
The source has detail in every pixel and Nearest is sampling it at random. Switch **Downscale** to Box
or LAB Average, enable **Smooth**, and turn on **Despeckle**.

**Small disconnected pixels remain after removing the background.**
Enable **Island Removal**, keep it below Pixel Art, and set **Maximum Island Size** to the largest
fragment that should disappear. Raise **Transparency Threshold** if a semi-transparent fringe is
still joining the fragment to the subject.

**Background removal ate part of my subject.**
Lower **Tolerance** — that is the pass that reaches everywhere. Raise **Edge Passes** instead to clean
the remaining halo, since the edge pass cannot reach enclosed areas.

**Background removal left a halo.**
Raise **Edge Passes** first, then **Edge Tolerance**. Leave **Tolerance** low.

**I need to remove several unrelated colours.**
Use **Color Removal** instead of Background Removal, add every colour to its list, and raise Tolerance
gradually. Keep it above Pixel Art when the swatches came from the source image.

**The outline is everywhere / the sprite looks like a wireframe.**
Raise **Minimum Contrast**. It is tracing quantization steps rather than real transitions.

**Colours shimmer between animation frames.**
Turn on **Animation Sequence** so all frames share one palette. If your frames are not numbered
consistently, rename them so the numbering matches, or select them all and use Batch Convert with
**Share One Palette**.

**The preview does not match my imported asset.**
The tool reads the *original file* rather than the imported texture, so import settings such as
maximum size and compression do not affect the conversion. This is deliberate — the artwork is the
source of truth. Textures with no file behind them, such as ones generated at runtime, are read from
the texture itself.

**The window is slow with a long animation.**
Turn off **Live Preview** in the toolbar and use **Refresh** to convert on demand. Above 24 frames the
window says so.

**"Fixed palette quantization was selected but no palette was supplied."**
Assign a palette asset in the Pixel Art section, or switch the quantization method.
