#!/usr/bin/env python3
# Dev tool (not shipped to browsers). Requires: pip install potracer pillow numpy scipy
"""Trace single icons from a sheet into sprite <symbol>s (potracer).
Usage: trace_icons.py sheet.jpg cols rows "name:col:row[:fill]" ...  -> prints symbols"""
import sys, numpy as np
from PIL import Image
import potrace
from scipy import ndimage

def trace(img, box, fill=False, target=100.0):
    g = np.asarray(img.convert('L').crop(box), dtype=np.float32)
    mask = g < 200                       # icon pixels are mid grey on white
    mask = ndimage.binary_opening(mask, iterations=1)
    if fill: mask = ndimage.binary_fill_holes(mask)
    lab, n = ndimage.label(mask)
    if n == 0: raise SystemExit('empty crop')
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    keep = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s > max(60, sizes.max() * 0.004)])
    ys, xs = np.nonzero(keep)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    keep = keep[y0:y1, x0:x1]
    k = target / max(keep.shape)
    bm = potrace.Bitmap(~keep)
    path = bm.trace(turdsize=20, alphamax=1.0, opticurve=True, opttolerance=0.3)
    f = lambda p: '%.1f %.1f' % (p.x * k, p.y * k)
    d = []
    for curve in path:
        d.append('M' + f(curve.start_point))
        for seg in curve:
            if seg.is_corner: d.append('L' + f(seg.c) + 'L' + f(seg.end_point))
            else: d.append('C' + f(seg.c1) + ' ' + f(seg.c2) + ' ' + f(seg.end_point))
        d.append('Z')
    w, h = keep.shape[1] * k, keep.shape[0] * k
    return '<symbol id="%%s" viewBox="-4 -4 %.2f %.2f"><path fill-rule="evenodd" d="%s"/></symbol>' % (w + 8, h + 8, ''.join(d))

if __name__ == '__main__':
    sheet, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    img = Image.open(sheet); W, H = img.size
    for spec in sys.argv[4:]:
        name, *rest = spec.split(':')
        if len(rest) >= 4 and all(x.isdigit() for x in rest[:4]):
            box = tuple(int(x) for x in rest[:4]); opt = rest[4:]
        else:
            c, r, *opt = rest; c, r = int(c), int(r)
            box = (int(W * c / cols), int(H * r / rows), int(W * (c + 1) / cols), int(H * (r + 1) / rows))
        print(trace(img, box, fill=bool(opt and opt[0] == 'fill')) % name)
