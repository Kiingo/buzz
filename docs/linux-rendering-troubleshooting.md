# Linux Rendering Troubleshooting

This guide covers the most common rendering failures on Linux and how to resolve them. It covers both the AppImage distribution and native package installs (`deb`, `rpm`).

## Symptoms and fixes at a glance

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Blank or transparent window, then `SIGABRT` with `colrv1_configure_skpaint` in the output | COLRv1 color emoji font (AppImage only) | Upgrade to the latest AppImage — the fix ships automatically |
| Blank window on startup, no crash output | dmabuf renderer incompatibility (NVIDIA or AppImage) | `WEBKIT_DISABLE_DMABUF_RENDERER=1 ./Buzz.AppImage` or `--safe-rendering` |
| Blank window on any hardware, no crash output | Unknown GPU/driver combination | `--safe-rendering` flag (see below) |

---

## Crash: `colrv1_configure_skpaint` assertion abort (AppImage)

**Affected distributions:** Fedora 40+ and any distro shipping Google's Noto Color Emoji in COLRv1 format (`Noto-COLRv1.ttf`). Issues [#2548](https://github.com/block/buzz/issues/2548), [#2982](https://github.com/block/buzz/issues/2982).

**Symptom:** Buzz starts, the window appears briefly (or stays blank), then the process aborts with output like:

```
././/include/c++/12/bits/stl_vector.h:1123: ... colrv1_configure_skpaint ...:
Assertion '__n < this->size()' failed.
```

**Root cause:** WebKitGTK's bundled Skia has an out-of-bounds bug when rendering COLRv1 color-format emoji fonts. Fedora's default emoji font (`/usr/share/fonts/google-noto-color-emoji-fonts/Noto-COLRv1.ttf`) triggers it on every startup that renders emoji.

**Fix (AppImage, shipped automatically):** The AppImage's launch shim sets `FONTCONFIG_FILE` to a bundled configuration that rejects color-format fonts from the font-match candidates presented to WebKit. This prevents the COLRv1 rendering path from being reached. Color emoji degrade to a non-COLRv1 fallback (CBDT or SVG format) when one is installed; otherwise they render as monochrome glyphs. The fix applies only to the Buzz process — your system emoji font is unaffected elsewhere.

This fix ships as part of `fix-appimage.sh` and is included in release AppImages starting with the version that merges this change.

**Workaround (before upgrading):** Add a fontconfig override that removes color-format fonts from Buzz's view:

```bash
mkdir -p ~/.config/buzz-fontconfig
cat > ~/.config/buzz-fontconfig/fonts.conf <<'XML'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <selectfont>
    <rejectfont>
      <pattern>
        <patelt name="color"><bool>true</bool></patelt>
      </pattern>
    </rejectfont>
  </selectfont>
</fontconfig>
XML
FONTCONFIG_FILE=~/.config/buzz-fontconfig/fonts.conf ./Buzz_*.AppImage
```

**Native packages (`deb`/`rpm`):** Not affected. Native packages use the system WebKitGTK, which handles COLRv1 fonts correctly on supported distros.

---

## Blank window on startup (no crash): dmabuf renderer

**Affected hardware:** NVIDIA GPUs (proprietary and nouveau drivers) and AppImage installs on any GPU. Issue [#2338](https://github.com/block/buzz/issues/2338).

**Symptom:** Buzz launches without any crash or assertion output, but the window is blank or invisible. The process is running (`ps aux | grep buzz`), but nothing renders.

**Root cause:** WebKitGTK's dmabuf zero-copy buffer path is incompatible with some GPU/driver/compositor combinations. The WebKit child process silently fails to paint.

**Fix (shipped automatically since v0.5.0):** Buzz sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` automatically before WebKit initializes when it detects an NVIDIA GPU (`/sys/class/drm` vendor ID `0x10de`) or when running as an AppImage. This restores a slightly slower shared-memory rendering path that works universally.

**If automatic detection doesn't help (`--safe-rendering`):** Pass `--safe-rendering` to force both `WEBKIT_DISABLE_DMABUF_RENDERER=1` and `WEBKIT_DISABLE_COMPOSITING_MODE=1` for that launch:

```bash
./Buzz_*.AppImage --safe-rendering
# or for a native install:
buzz-desktop --safe-rendering
```

`--safe-rendering` is a per-launch flag — it is not remembered between runs. If it fixes your issue, you can make it permanent by setting the env vars yourself:

```bash
# ~/.bashrc or ~/.profile
export WEBKIT_DISABLE_DMABUF_RENDERER=1
```

**Conflict detection:** If you set a WebKit variable in your environment and also pass `--safe-rendering`, Buzz will refuse to start and print exactly which variable conflicts. Unset the conflicting variable or drop the flag.

---

## AMD RDNA4 / transparent window

**Affected hardware:** AMD RDNA4 GPUs (RX 9000 series) with the `radv` driver. Issue [#2643](https://github.com/block/buzz/issues/2643).

**Symptom:** The Buzz window is transparent or renders with graphical corruption on AMD RDNA4 hardware.

**Workaround (verified by reporter):** Set these three variables before launching Buzz:

```bash
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export WEBKIT_FORCE_SANDBOX=0
export GSK_RENDERER=cairo
./Buzz_*.AppImage
# or for native:
buzz-desktop
```

`GSK_RENDERER=cairo` switches GTK's scene kit renderer to the software path; `WEBKIT_FORCE_SANDBOX=0` is required for certain Mesa/radv driver combinations. A dedicated fix for RDNA4 detection is being tracked in [#2643](https://github.com/block/buzz/issues/2643).

---

## Diagnosing an unrecognised crash

If none of the above match your situation:

1. Run Buzz from a terminal and capture the output:
   ```bash
   ./Buzz_*.AppImage 2>&1 | tee buzz-crash.log
   ```

2. Check for a core dump:
   ```bash
   coredumpctl list | tail
   coredumpctl info <PID>
   ```

3. Try `--safe-rendering` first — if it resolves the issue, it's a WebKit rendering incompatibility and the crash log will help narrow down which driver is involved.

4. File a [new issue](https://github.com/block/buzz/issues/new) with your distro, GPU, driver version, and the terminal output.
