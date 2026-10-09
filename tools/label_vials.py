"""Print a Varsity Labs label onto the blank white label of every vial photo:
logo mark + wordmark, maroon rule, product name, 'for research use only'. The block is warped onto a cylinder and multiplied
into the photo so the real label shading and curvature read through."""
import sys, os, glob, math, json
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy import ndimage
HERE = os.path.dirname(os.path.abspath(__file__))
SRC, DST = sys.argv[1], sys.argv[2]
ONLY = set(sys.argv[3].split(",")) if len(sys.argv) > 3 and sys.argv[3] else None
SKIP = {"p-prep-pads.jpg", "p-syringes.jpg"}
OVERRIDES = json.load(open(os.path.join(HERE, "label_overrides.json")))
PRODUCTS = json.load(open(os.path.join(HERE, "label_products.json")))   # slug -> [name, size, category]
MAROON = (0x6b, 0x1f, 0x2b); INK = (0x26, 0x20, 0x1d); GREY = (0x7d, 0x73, 0x6d)
def font(name, size):
    p = os.path.join(HERE, name)
    try: return ImageFont.truetype(p, max(6, int(size)))
    except Exception: return ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", max(6, int(size)))
def fit(name, text, width, start):
    size = start
    while size > 6 and font(name, size).getlength(text) > width: size -= 1
    return font(name, size)
def render_block(W, product):
    """Flat label artwork for a label of visible width W, drawn on a transparent canvas W wide. Returns RGBA."""
    SS = 2; W2 = W * SS; C = 0.80 * W2; x0 = (W2 - C) / 2
    H2 = int(0.50 * W2); im = Image.new("RGBA", (int(W2), H2), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    y = 0.0
    # header: logo mark + wordmark
    mh = 0.13 * W2; gap = 0.045 * W2
    d.rounded_rectangle([x0, y, x0 + mh, y + mh], radius=mh * 0.22, fill=MAROON)
    fv = font("Archivo-800.ttf", mh * 0.72); bb = fv.getbbox("V")
    d.text((x0 + mh / 2 - (bb[0] + bb[2]) / 2, y + mh / 2 - (bb[1] + bb[3]) / 2), "V", font=fv, fill=(255, 255, 255))
    fw = fit("Archivo-800.ttf", "Varsity Labs", C - mh - gap, mh * 0.78); bb = fw.getbbox("Varsity Labs")
    d.text((x0 + mh + gap - bb[0], y + mh / 2 - (bb[1] + bb[3]) / 2), "Varsity Labs", font=fw, fill=INK)
    y += mh + 0.055 * W2
    d.rectangle([x0, y, x0 + C, y + max(2, 0.012 * W2)], fill=MAROON); y += 0.012 * W2 + 0.05 * W2
    # product name
    name = product[0]
    fn = fit("Archivo-700.ttf", name, C, 0.085 * W2); bb = fn.getbbox(name)
    d.text((x0 - bb[0], y - bb[1]), name, font=fn, fill=INK); y += (bb[3] - bb[1]) + 0.045 * W2
    # footer
    ft = font("Archivo-700.ttf", 0.036 * W2); t = "FOR RESEARCH USE ONLY"; x = x0
    for ch in t:  # letter-spaced
        d.text((x, y), ch, font=ft, fill=GREY); x += ft.getlength(ch) + 0.012 * W2
    y += 0.036 * W2 * 1.3
    im = im.crop((0, 0, int(W2), int(y + 2)))
    # cylinder warp: columns compress toward the edges as the label wraps round the vial
    a = np.asarray(im).astype(np.float32); h, w = a.shape[:2]
    tmax = math.radians(62); xs = np.arange(w); u = (xs - w / 2) / (w / 2)
    theta = np.arcsin(np.clip(u * math.sin(tmax), -1, 1)); src = (theta / tmax) * (w / 2) + w / 2
    i0 = np.clip(np.floor(src).astype(int), 0, w - 1); i1 = np.clip(i0 + 1, 0, w - 1); f = (src - i0)[None, :, None]
    warped = a[:, i0] * (1 - f) + a[:, i1] * f
    # soft edge shading: ink darkens a touch where the label curves away
    shade = (0.82 + 0.18 * np.cos(theta))[None, :, None]; warped[..., :3] = warped[..., :3] * shade + 255 * (1 - shade) * (warped[..., 3:4] / 255)
    out = Image.fromarray(warped.clip(0, 255).astype(np.uint8)).resize((int(w / SS), int(h / SS)), Image.LANCZOS)
    return out.filter(ImageFilter.GaussianBlur(0.4))
def stamp(layer, cx, cy, width, ang, product):
    block = render_block(width, product)
    # anchor: the old single-line placement sat at the label's upper part; put the block's top a little above that point
    bw, bh = block.size; pad = 30
    t = Image.new("RGBA", (bw + pad * 2, bh + pad * 2), (0, 0, 0, 0)); t.paste(block, (pad, pad))
    t = t.rotate(ang, resample=Image.BICUBIC, expand=True)
    r = math.radians(ang); off = -0.10 * width + bh / 2   # block centre sits (bh/2 - 0.10W) below the anchor
    px, py = cx - off * math.sin(r), cy + off * math.cos(r)
    layer.paste(t, (int(px - t.width / 2), int(py - t.height / 2)), t)
def minrect_angle(xs, ys):
    best = None
    for deg in np.arange(-45, 45.5, 0.5):
        r = math.radians(deg); c, s = math.cos(r), math.sin(r)
        u = xs * c + ys * s; v = -xs * s + ys * c
        area = (np.percentile(u, 99.5) - np.percentile(u, 0.5)) * (np.percentile(v, 99.5) - np.percentile(v, 0.5))
        if best is None or area < best[0]: best = (area, deg)
    return best[1]
def blobs(im):
    a = np.asarray(im).astype(int); mn, mx = a.min(2), a.max(2); H, W = mn.shape
    mask = ndimage.binary_opening((mn > 115) & ((mx - mn) < 75), structure=np.ones((17, 17), bool))
    lab, n = ndimage.label(mask); out = []
    for k in range(1, n + 1):
        m = lab == k; ys, xs = np.nonzero(m); area = len(xs)
        if area < 0.012 * H * W or ys.mean() < 0.25 * H or ys.mean() > 0.92 * H or np.ptp(xs) > 0.6 * W: continue
        out.append((area, xs, ys, m))
    out.sort(key=lambda t: -t[0])
    if len(out) > 1 and (abs(out[1][2].mean() - out[0][2].mean()) > 0.2 * H or out[1][0] < 0.4 * out[0][0]): out = out[:1]
    return out[:2]
def place(im, xs, ys, m):
    ang = minrect_angle(xs, ys)
    M = Image.fromarray((m * 255).astype(np.uint8)).rotate(ang, resample=Image.NEAREST, expand=False)
    mm = np.asarray(M) > 127; rows = np.nonzero(mm.any(1))[0]; top = rows.min()
    widths = [(y, xx.min(), xx.max()) for y in range(top, min(top + 400, rows.max() + 1)) for xx in [np.nonzero(mm[y])[0]] if len(xx)]
    w0 = np.median([x1 - x0 for _, x0, x1 in widths[10:60]]) if len(widths) > 60 else np.median([x1 - x0 for _, x0, x1 in widths])
    band = [(y, x0, x1) for y, x0, x1 in widths if y <= top + 0.5 * w0]
    width = float(np.median([x1 - x0 for _, x0, x1 in band])); cxr = float(np.median([(x0 + x1) / 2 for _, x0, x1 in band])); cyr = top + 0.30 * width
    W, H = im.size; r = math.radians(-ang); c, s = math.cos(r), math.sin(r); dx, dy = cxr - W / 2, cyr - H / 2
    return W / 2 + dx * c - dy * s, H / 2 + dx * s + dy * c, width, ang
def label_one(path, out):
    im = Image.open(path).convert("RGB"); W, H = im.size; b = os.path.basename(path); slug = b[2:-4]
    product = PRODUCTS.get(slug) or [slug.replace("-", " ").title(), "", ""]
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0)); n = 0
    spots = OVERRIDES.get(b) or [place(im, xs, ys, m) for _, xs, ys, m in blobs(im)]
    for cx, cy, width, ang in spots: stamp(layer, cx, cy, width, ang, product); n += 1
    if not n: print("  NO LABEL:", b)
    a = np.asarray(im).astype(float); l = np.asarray(layer).astype(float); al = l[..., 3:4] / 255.0
    ink = l[..., :3] * al + 255 * (1 - al)            # artwork over white
    res = a * ink / 255.0                              # multiply onto the photo
    Image.fromarray(res.clip(0, 255).astype(np.uint8)).save(out, quality=92, subsampling=0)
    print(f"  {b}: {n} label(s), {product[0]}")
for p in sorted(glob.glob(os.path.join(SRC, "p-*.jpg"))):
    b = os.path.basename(p)
    if b in SKIP or (ONLY and b not in ONLY): continue
    label_one(p, os.path.join(DST, b))
print("done")
