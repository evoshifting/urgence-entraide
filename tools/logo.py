"""Logo « Relais » d'Urgence Entraide : source unique du signe.

Écrit logo.svg et favicon.svg, et insère le signe animable dans index.html
(id header-logo-svg) et app.js (overlayLogoSvgMarkup). Les PNG (icônes d'appli,
apple-touch, og-image, favicon.ico) sont produits par tools/render-icons.mjs.

    python3 tools/logo.py
"""
import math, pathlib, re
ROOT = pathlib.Path(__file__).resolve().parent.parent
TILE, DOT, W1, W2 = "#0B2545", "#F97316", "#FFFFFF", "#7DD3FC"   # palette « Sécurité civile »
C = 32

def _halves(r, side):
    a = math.radians(40); sx = 1 if side == "r" else -1
    x0 = C + sx * r; xe = C + sx * r * math.cos(a)
    up = 0 if side == "r" else 1
    return (f"M{x0:.2f} {C} A{r} {r} 0 0 {up} {xe:.2f} {C - r * math.sin(a):.2f}",
            f"M{x0:.2f} {C} A{r} {r} 0 0 {1 - up} {xe:.2f} {C + r * math.sin(a):.2f}")

def mark(svg_id=None, size=64, small=False, cls="", static=False):
    sw, r1, r2, dot = (5.4, 12.5, 21.5, 6) if small else (3.2, 11.5, 20, 4.6)
    ident = f' id="{svg_id}"' if svg_id else ""
    klass = f' class="{cls}"' if cls else ""
    pl = '' if static else ' pathLength="1"'
    w1 = "".join(f'<path class="mk-w1"{pl} d="{d}"/>' for s in "rl" for d in _halves(r1, s))
    w2 = "".join(f'<path class="mk-w2"{pl} d="{d}"/>' for s in "rl" for d in _halves(r2, s))
    ring = '' if static else f'<circle class="mk-ring" cx="{C}" cy="{C}" r="{dot}" fill="none" stroke="{DOT}" stroke-width="1.4" opacity="0"/>'
    return (f'<svg{ident}{klass} width="{size}" height="{size}" viewBox="0 0 64 64" aria-hidden="true">'
            f'<rect width="64" height="64" rx="15" fill="{TILE}"/>{ring}'
            f'<g fill="none" stroke-linecap="round" stroke-width="{sw}"><g stroke="{W1}">{w1}</g><g stroke="{W2}">{w2}</g></g>'
            f'<circle class="mk-dot" cx="{C}" cy="{C}" r="{dot}" fill="{DOT}"/></svg>')

def standalone(svg): return svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"', 1)

if __name__ == "__main__":
    (ROOT / "logo.svg").write_text(standalone(mark(static=True)) + "\n")
    (ROOT / "favicon.svg").write_text(standalone(mark(small=True, static=True)) + "\n")
    idx = ROOT / "index.html"; s = idx.read_text()
    s, n = re.subn(r'<svg id="header-logo-svg".*?</svg>(?=\s*<span class="brand__txt")',
                   mark("header-logo-svg", 44, cls="brand__logo"), s, count=1, flags=re.S)
    assert n == 1, "logo de l'en-tête introuvable"; idx.write_text(s)
    app = ROOT / "app.js"; a = app.read_text()
    a, n = re.subn(r"function overlayLogoSvgMarkup\(\) \{\n  return `.*?`;\n\}",
                   "function overlayLogoSvgMarkup() {\n  return `" + mark("overlay-logo-svg", 88, cls="uei-overlay-logo") + "`;\n}", a, count=1, flags=re.S)
    assert n == 1, "overlayLogoSvgMarkup introuvable"; app.write_text(a)
    print("logo.svg, favicon.svg, en-tête et overlay mis à jour")
