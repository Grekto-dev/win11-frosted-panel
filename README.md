# Win11 Frosted Panel

A lightweight **Cinnamon desktop extension** (`win11-frosted-panel@pedro`) that brings Windows 11-style frosted **Acrylic glass** (`GLSL` Dual-Kawase blur, luminosity blend, tint, micro-grain noise, and 1px hairline highlight) to Cinnamon panels, taskbar buttons, and Start Menu popups.

## Features

- **Windows 11 Acrylic Glass Pipeline**: Multi-pass GLSL Dual-Kawase blur (`blur_down.glsl` / `blur_up.glsl`) combined with Acrylic luminosity/tint/noise/hairline compositing (`acrylic.glsl`).
- **Color Modes (`preset`)**:
  - **Follow System (Default)**: Automatically switches between Windows 11 Light and Dark modes by tracking Cinnamon/GTK/GNOME theme settings.
  - **Windows 11 Dark & Windows 11 Light**: Calibrated Acrylic material presets for both taskbars and Start Menu surfaces.
  - **Custom**: Full control over blur radius, luminosity blend color/opacity, tint color/opacity, backdrop saturation, noise grain, and 1px inner-edge hairline.
- **Opacity Control (`opacity-level`)**: Smooth slider (`0.0` to `1.0`, default `0.60`) scaling the calibrated Acrylic translucency.
- **Start Menu Frosting (`blur-start-menu`)**: Applies backdrop-aware Acrylic blur behind Cinnamon/Win11 Start Menu popups (capturing windows directly behind the menu rather than only desktop wallpaper).
- **Taskbar Button Styling (`style-panel-buttons`)**: Windows 11-inspired hover/focus pill transitions, active/running underline indicators, and Show Desktop corner styling (`stylesheet.css`).
- **Bilingual Settings UI**: English (Default) and Português (Brasil) (`pt_BR`) included via compiled gettext translation (`locale/` and `po/pt_BR.po`).

## Compatibility

- Cinnamon `6.0`, `6.2`, `6.4`, `6.6` (X11 / Clutter / Cogl GLSL)

## Installation

1. Clone or copy this repository into your Cinnamon extensions directory using the extension UUID:

   ```bash
   git clone https://github.com/Grekto-dev/win11-frosted-panel.git \
     ~/.local/share/cinnamon/extensions/win11-frosted-panel@pedro
   ```

2. Open **System Settings → Extensions**, enable **Win11 Frosted Panel**, and open its settings icon to configure appearance, opacity, Start Menu blur, and language.

## Rebuilding Translations

If you edit `po/pt_BR.po`, recompile the `.mo` catalog with:

```bash
msgfmt -o locale/pt_BR/LC_MESSAGES/win11-frosted-panel@pedro.mo po/pt_BR.po
```
