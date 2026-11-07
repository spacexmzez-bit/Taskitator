#!/usr/bin/env python3
# Dev tool (not shipped to browsers). Requires: pip install potracer pillow numpy scipy
"""Trace a two-tone logo PNG (navy body + bright swash) into an SVG <symbol>.
Body path uses currentColor; swash uses var(--tk-logo-accent)."""
import sys, numpy as np
from PIL import Image
import potrace
from scipy import ndimage

def layer(mask, k):
    bm = potrace.Bitmap(~mask)
    path = bm.trace(turdsize=30, alphamax=1.0, opticurve=True, opttolerance=0.3)
    f = lambda p: '%.1f %.1f' % (p.x * k, p.y * k)
    d = []
    for c in path:
        d.append('M' + f(c.start_point))
        for s in c:
            d.append(('L' + f(s.c) + 'L' + f(s.end_point)) if s.is_corner else ('C' + f(s.c1) + ' ' + f(s.c2) + ' ' + f(s.end_point)))
        d.append('Z')
    return ''.join(d)

def trace(fn, sid, up=3):
    im = Image.open(fn).convert('RGBA')
    im = im.resize((im.width * up, im.height * up), Image.LANCZOS)
    a = np.asarray(im).astype(np.float32)
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    solid = al > 110
    swash = solid & (b > 175) & (b - r > 90)
    body = solid & ~swash
    body = ndimage.binary_opening(body, iterations=1)
    swash = ndimage.binary_opening(swash, iterations=1)
    ys, xs = np.nonzero(solid)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    body, swash = body[y0:y1, x0:x1], swash[y0:y1, x0:x1]
    k = 1.0 / up
    w, h = (x1 - x0) * k, (y1 - y0) * k
    out = '<symbol id="%s" viewBox="0 0 %.1f %.1f"><path fill-rule="evenodd" fill="currentColor" d="%s"/>' % (sid, w, h, layer(body, k))
    if swash.sum() > 50:
        out += '<path fill-rule="evenodd" style="fill:var(--tk-logo-accent,#1f6fff)" d="%s"/>' % layer(swash, k)
    return out + '</symbol>'

if __name__ == '__main__':
    for spec in sys.argv[1:]:
        fn, sid = spec.split('=')
        print(trace(fn, sid))
