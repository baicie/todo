"""Regenerate Tauri raster icons from the checked-in vector design.

Usage:
    python apps/native/scripts/generate-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src-tauri" / "icons"
SIZE = 1024


def build_master() -> Image.Image:
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gradient = Image.new("RGBA", (SIZE, SIZE))
    gradient_draw = ImageDraw.Draw(gradient)
    start = (93, 125, 242)
    end = (53, 80, 196)
    for y in range(SIZE):
        ratio = y / (SIZE - 1)
        color = tuple(round(a + (b - a) * ratio) for a, b in zip(start, end))
        gradient_draw.line((0, y, SIZE, y), fill=(*color, 255))

    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle((48, 48, 976, 976), radius=224, fill=255)
    image.paste(gradient, (0, 0), mask)

    draw = ImageDraw.Draw(image)
    points = [(280, 530), (438, 682), (754, 346)]
    draw.line(points, fill=(255, 255, 255, 255), width=92, joint="curve")
    for x, y in (points[0], points[-1]):
        draw.ellipse((x - 46, y - 46, x + 46, y + 46), fill=(255, 255, 255, 255))
    draw.ellipse((734, 734, 846, 846), fill=(255, 209, 102, 255))
    return image


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    print("building master", flush=True)
    master = build_master()
    print("saving master", flush=True)
    master.save(OUT / "icon.png", "PNG")
    for size, name in [
        (32, "32x32.png"),
        (64, "64x64.png"),
        (128, "128x128.png"),
        (256, "128x128@2x.png"),
        (512, "icon-512.png"),
    ]:
        print(f"saving {name}", flush=True)
        master.resize((size, size), Image.Resampling.LANCZOS).save(
            OUT / name, "PNG"
        )
    print("saving icon.ico", flush=True)
    master.save(
        OUT / "icon.ico",
        "ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"icons written to {OUT}", flush=True)


if __name__ == "__main__":
    main()
