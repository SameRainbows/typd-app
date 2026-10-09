"""Pack the PNGs from scripts/build-icons.js into the icon files Typd and its site use.

    python scripts/build-icons.py [mark]          (default: ligature)

assets/typd.ico   Windows app icon: the exact 16/24/32 frames, then 48-256 from the master
assets/typd.png   1024 px, macOS (electron-builder makes the .icns from it) and Linux
../typd-site/public/favicon.ico, apple-touch-icon.png, icon.svg   the landing page
"""
import shutil, sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
mark = sys.argv[1] if len(sys.argv) > 1 else "ligature"
src = ROOT / "assets" / "icon-build" / mark
frames = [Image.open(src / f"win-{n}.png").convert("RGBA") for n in (256, 128, 64, 48, 32, 24, 16)]
# Pillow writes every given frame as-is when they are passed with append_images.
frames[0].save(ROOT / "assets" / "typd.ico", format="ICO", sizes=[f.size for f in frames], append_images=frames[1:])
shutil.copyfile(src / "mac-1024.png", ROOT / "assets" / "typd.png")

site = ROOT.parent / "typd-site" / "public"
if site.exists():
    small = [Image.open(src / f"win-{n}.png").convert("RGBA") for n in (48, 32, 16)]
    small[0].save(site / "favicon.ico", format="ICO", sizes=[f.size for f in small], append_images=small[1:])
    shutil.copyfile(src / "touch-180.png", site / "apple-touch-icon.png")
    shutil.copyfile(ROOT / "assets" / "brand" / mark / "app-icon-win.svg", site / "icon.svg")

check = Image.open(ROOT / "assets" / "typd.ico")
print("typd.ico frames:", sorted(check.info.get("sizes", []) or [check.size]))
print("typd.png:", Image.open(ROOT / "assets" / "typd.png").size)
