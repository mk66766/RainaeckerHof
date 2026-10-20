from PIL import Image, ImageDraw, ImageFont, ImageFilter
import math

S = 3  # Supersampling
FONT_B = '/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf'
FONT_M = '/usr/share/fonts/truetype/google-fonts/Poppins-Medium.ttf'
YOLK, YOLK_HI, YOLK_LO = (244,180,0), (255,214,90), (214,150,0)
INK, CREAM, MUTED = (30,42,34), (243,246,238), (184,201,188)

def egg_points(cx, cy, a, b, n=240):
    pts = []
    for i in range(n):
        t = 2*math.pi*i/n
        s = math.sin(t)
        x = cx + a*math.cos(t)*(1 - 0.17*s)     # oben schmaler
        y = cy - b*s
        pts.append((x, y))
    return pts

def draw_egg(img, cx, cy, a, b, shadow=True):
    W, H = img.size
    if shadow:
        sh = Image.new('RGBA', img.size, (0,0,0,0))
        d = ImageDraw.Draw(sh)
        d.ellipse((cx-a*0.95, cy+b*0.86, cx+a*0.95, cy+b*1.10), fill=(0,0,0,110))
        sh = sh.filter(ImageFilter.GaussianBlur(14*S))
        img.alpha_composite(sh)
    # Ei-Maske
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).polygon(egg_points(cx, cy, a, b), fill=255)
    # Verlauf (oben hell, unten dunkler)
    grad = Image.new('RGBA', img.size, YOLK + (255,))
    gd = ImageDraw.Draw(grad)
    top, bot = int(cy-b), int(cy+b)
    for y in range(top, bot):
        k = (y-top)/(bot-top)
        c = tuple(int(YOLK[j]*(1-k*0.0) + (YOLK_LO[j]-YOLK[j])*k*0.9) for j in range(3))
        gd.line([(0,y),(W,y)], fill=c+(255,))
    img.paste(grad, (0,0), mask)
    # Glanzlicht (weich, ueber Maske statt RGBA-Blur, damit keine dunklen Raender entstehen)
    hl = Image.new('L', img.size, 0)
    ImageDraw.Draw(hl).ellipse((cx-a*0.70, cy-b*0.80, cx-a*0.10, cy-b*0.10), fill=125)
    hl = hl.filter(ImageFilter.GaussianBlur(20*S))
    from PIL import ImageChops
    hl = ImageChops.multiply(hl, mask)
    img.paste(Image.new('RGBA', img.size, YOLK_HI+(255,)), (0,0), hl)

def hills(img, y0, color, amp, period, phase):
    W, H = img.size
    d = ImageDraw.Draw(img)
    pts = [(x, y0 + amp*math.sin((x/period)*2*math.pi + phase)) for x in range(0, W+8, 8)]
    d.polygon(pts + [(W,H),(0,H)], fill=color)

def fit_font(path, text, max_w, start):
    size = start
    while size > 20:
        f = ImageFont.truetype(path, size)
        if f.getlength(text) <= max_w: return f
        size -= 2
    return ImageFont.truetype(path, 20)

# ---------- Vorschaubild 1200x630 ----------
W, H = 1200*S, 630*S
img = Image.new('RGBA', (W, H))
d = ImageDraw.Draw(img)
for y in range(H):
    k = y/H
    c = (int(36-14*k), int(52-18*k), int(40-14*k))
    d.line([(0,y),(W,y)], fill=c+(255,))
hills(img, 500*S, (47,78,56,255), 26*S, 900*S, 0.6)
hills(img, 548*S, (58,98,68,255), 22*S, 700*S, 2.2)
hills(img, 590*S, (40,70,48,255), 14*S, 520*S, 4.0)
draw_egg(img, 270*S, 290*S, 130*S, 168*S)
d = ImageDraw.Draw(img)
title = 'Rainäcker Hof'
x0 = 490*S
f = fit_font(FONT_B, title, (1200-60)*S - x0, 104*S)
d.text((x0, 190*S), title, font=f, fill=CREAM)
d.rounded_rectangle((x0, 190*S + f.size*1.30, x0 + 150*S, 190*S + f.size*1.30 + 9*S), radius=5*S, fill=YOLK)
sub = ImageFont.truetype(FONT_M, 44*S)
d.text((x0, 190*S + f.size*1.30 + 34*S), 'Hühner & Ziegen', font=sub, fill=MUTED)
img.convert('RGB').resize((1200,630), Image.LANCZOS).save('og-image.png', optimize=True)

# ---------- App-Symbole (Vollfläche, Ei in der sicheren Zone) ----------
def icon(size):
    s = size*S
    im = Image.new('RGBA', (s, s))
    d = ImageDraw.Draw(im)
    for y in range(s):
        k = y/s
        d.line([(0,y),(s,y)], fill=(int(40-14*k), int(58-18*k), int(44-14*k), 255))
    # sanfter Hügel
    hills(im, int(s*0.80), (58,98,68,255), s*0.025, s*0.9, 1.0)
    draw_egg(im, s*0.5, s*0.46, s*0.215, s*0.285, shadow=True)
    return im.convert('RGB').resize((size,size), Image.LANCZOS)

for n, sz in [('icon-512.png',512),('icon-192.png',192),('apple-touch-icon.png',180),('favicon-32.png',32)]:
    icon(sz).save(n, optimize=True)

# ---------- Favicon als SVG ----------
pts = ' '.join(f'{x:.1f},{y:.1f}' for x,y in egg_points(32,31,15,19,80))
open('favicon.svg','w').write(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="14" fill="#263829"/>
<polygon points="{pts}" fill="#F4B400"/>
<ellipse cx="25" cy="22" rx="5" ry="7" fill="#FFD65A" opacity=".55"/>
</svg>''')

open('manifest.webmanifest','w',encoding='utf-8').write('''{
  "name": "Rainäcker Hof",
  "short_name": "Rainäcker",
  "description": "Gemeinschafts-App für Hühner und Ziegen",
  "lang": "de",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#EDF1E8",
  "theme_color": "#263829",
  "icons": [
    {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
    {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
    {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}
  ]
}
''')
print('fertig')
