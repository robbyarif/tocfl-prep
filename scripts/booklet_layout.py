# Reports where each question number sits on each booklet page (PyMuPDF), the question-marker
# labels, and the embedded pictures. Optionally saves the pictures as PNG files.
#   python scripts/booklet_layout.py <booklet.pdf> [image_dir]
# Prints JSON: {"pages": [{"w": .., "h": .., "numbers": [{"n": 1, "y": 123.4}, ...],
#                          "markers": [{"k": "一", "y": 88.0}, ...],
#                          "images": [{"file": "p9_80.png", "x0": .., "y0": .., "x1": .., "y1": ..}, ...]}, ...]}
# Only numbers at the left margin count (question numbers), and only "n." or "n" words.
import json
import os
import re
import sys

import fitz

pdf = fitz.open(sys.argv[1])
image_dir = sys.argv[2] if len(sys.argv) > 2 else None
if image_dir:
    os.makedirs(image_dir, exist_ok=True)
out = {"pages": []}
for pno, page in enumerate(pdf):
    w, h = page.rect.width, page.rect.height
    nums = []
    marks = []
    for x in page.get_text("words"):
        x0, y0, _, _, word = x[0], x[1], x[2], x[3], x[4]
        m = re.fullmatch(r"(\d{1,2})\.?", word)
        # Part 2 picture questions number their items a little further in (about 15% of the width).
        if m and x0 < 0.2 * w:
            nums.append({"n": int(m.group(1)), "y": round(y0, 2)})
        # Reading part 5 passages are labelled (一) (二) ... before their question.
        mk = re.fullmatch(r"[(（]([一二三四五六七八九十]+)[)）]", word)
        if mk and x0 < 0.2 * w:
            marks.append({"k": mk.group(1), "y": round(y0, 2)})
    nums.sort(key=lambda d: d["y"])
    marks.sort(key=lambda d: d["y"])
    images = []
    for img in page.get_images(full=True):
        xref = img[0]
        for r in page.get_image_rects(xref):
            entry = {"x0": round(r.x0, 2), "y0": round(r.y0, 2), "x1": round(r.x1, 2), "y1": round(r.y1, 2)}
            if image_dir:
                pix = fitz.Pixmap(pdf, xref)
                if pix.colorspace is None or pix.colorspace.name not in ("DeviceGray", "DeviceRGB"):
                    pix = fitz.Pixmap(fitz.csRGB, pix)
                if pix.alpha:
                    pix = fitz.Pixmap(pix, 0)  # PNG from RGB only
                name = f"p{pno + 1}_{xref}.png"
                pix.save(os.path.join(image_dir, name))
                entry["file"] = name
            images.append(entry)
    out["pages"].append({"w": round(w, 2), "h": round(h, 2), "numbers": nums, "markers": marks, "images": images})
print(json.dumps(out))
