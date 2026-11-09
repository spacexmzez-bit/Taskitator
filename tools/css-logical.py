#!/usr/bin/env python3
"""Convert physical left/right CSS to logical properties so dir="rtl" mirrors the layout
while LTR rendering stays identical. Run once per file; idempotent.
Kept physical on purpose: centring (left:50% + translate), elements that JS positions with
style.left (tour card/arrow, Universe tab indicator), decorative scene/cloud/bird layers whose
art is not mirrored, and chevrons drawn from two borders + rotate().
Not handled here (see rtl.css): transforms, box-shadow offsets, text arrows.
Usage: python3 tools/css-logical.py file.css [...]"""
import re, sys

KEEP_SEL = re.compile(r'\.tt-|#tk-clouds|#tk-scene|\.uni-tab-indicator|\.tk-leaf|\.tk-bird|#tk-bird')
SIDE = {'left': 'start', 'right': 'end'}

def split_decls(body):
    out, depth, cur = [], 0, ''
    for ch in body:
        if ch == '(': depth += 1
        elif ch == ')': depth -= 1
        if ch == ';' and depth == 0:
            out.append(cur); cur = ''
        else:
            cur += ch
    out.append(cur)
    return out

def values(v):
    return re.findall(r'(?:[\w.%#-]*\((?:[^()]|\([^()]*\))*\)|[^\s]+)', v.strip())

def convert_decl(decl, sel, centred, rotated=False):
    m = re.match(r'(\s*)([-\w]+)(\s*:\s*)(.*?)(\s*)$', decl, re.S)
    if not m: return decl
    lead, prop, colon, val, tail = m.groups()
    p = prop.lower()
    imp = ''
    vm = re.match(r'(.*?)(\s*!important)$', val, re.S)
    if vm: val, imp = vm.group(1), vm.group(2)
    def out(np, nv): return f'{lead}{np}{colon}{nv}{imp}{tail}'
    keep_pos = KEEP_SEL.search(sel) or centred
    if p in ('left', 'right') and not keep_pos:
        return out('inset-inline-' + SIDE[p], val)
    mm = re.match(r'(margin|padding)-(left|right)$', p)
    if mm: return out(f'{mm.group(1)}-inline-{SIDE[mm.group(2)]}', val)
    mm = re.match(r'border-(left|right)(-(?:width|color|style))?$', p)
    if mm and rotated:  # chevrons drawn from two borders + rotate() must keep their shape
        return decl
    if mm: return out(f'border-inline-{SIDE[mm.group(1)]}{mm.group(2) or ""}', val)
    mm = re.match(r'border-(top|bottom)-(left|right)-radius$', p)
    if mm: return out(f'border-{"start" if mm.group(1)=="top" else "end"}-{SIDE[mm.group(2)]}-radius', val)
    if p == 'text-align' and val.strip() in ('left', 'right'):
        return out(p, {'left': 'start', 'right': 'end'}[val.strip()])
    if p == 'float' and val.strip() in ('left', 'right'):
        return out(p, 'inline-' + SIDE[val.strip()])
    if p in ('margin', 'padding', 'inset') and not (p == 'inset' and keep_pos):
        vs = values(val)
        if len(vs) == 4 and vs[1] != vs[3]:
            pre = p
            return f'{lead}{pre}-block{colon}{vs[0]} {vs[2]}{imp}; {pre}-inline{colon}{vs[3]} {vs[1]}{imp}{tail}'
    if p == 'border-radius' and '/' not in val:
        vs = values(val)
        if len(vs) in (2, 3, 4):
            tl, tr, br, bl = (vs[0], vs[1], vs[0], vs[1]) if len(vs) == 2 else (vs[0], vs[1], vs[2], vs[1]) if len(vs) == 3 else vs
            if tl != tr or br != bl:
                return (f'{lead}border-start-start-radius{colon}{tl}{imp}; border-start-end-radius{colon}{tr}{imp}; '
                        f'border-end-end-radius{colon}{br}{imp}; border-end-start-radius{colon}{bl}{imp}{tail}')
    if p == 'transition' and re.search(r'(^|,)\s*(left|right)\b', val):
        val = re.sub(r'(^|,)(\s*)(left|right)\b', lambda x: x.group(1) + x.group(2) + 'inset-inline-' + SIDE[x.group(3)], val)
        return out(p, val)
    return decl

def convert(css):
    out, i, n = [], 0, len(css)
    stack = []  # at-rule / selector names for open blocks
    buf_start = 0
    while i < n:
        if css.startswith('/*', i):
            j = css.find('*/', i + 2); j = n if j < 0 else j + 2
            out.append(css[i:j]); i = j; continue
        ch = css[i]
        if ch == '{':
            # selector/prelude is the text since the last ; { or }
            k = max(css.rfind(';', 0, i), css.rfind('{', 0, i), css.rfind('}', 0, i))
            prelude = css[k + 1:i]
            # Is this a leaf block? (no nested '{' before matching '}')
            depth, j = 1, i + 1
            leaf = True
            while j < n and depth:
                if css.startswith('/*', j):
                    e = css.find('*/', j + 2); j = n if e < 0 else e + 2; continue
                if css[j] == '{': depth += 1; leaf = False
                elif css[j] == '}': depth -= 1
                j += 1
            in_kf = any('keyframes' in s for s in stack) or 'keyframes' in prelude
            if leaf and not in_kf:
                body = css[i + 1:j - 1]
                centred = bool(re.search(r'translate(X)?\(\s*-50%', body) or re.search(r'(^|[;\s])(left|right)\s*:\s*50%', body))
                rotated = 'rotate(' in body
                body2 = ';'.join(convert_decl(d, prelude, centred, rotated) for d in split_decls(body))
                out.append('{' + body2 + '}'); i = j; continue
            stack.append(prelude); out.append(ch); i += 1; continue
        if ch == '}':
            if stack: stack.pop()
            out.append(ch); i += 1; continue
        out.append(ch); i += 1
    return ''.join(out)

if __name__ == '__main__':
    for f in sys.argv[1:]:
        s = open(f, encoding='utf8').read()
        t = convert(s)
        if t != s:
            open(f, 'w', encoding='utf8').write(t)
            print('converted', f)
