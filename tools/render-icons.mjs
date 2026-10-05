// Génère les images de l'identité à partir de logo.svg / favicon.svg (tools/logo.py).
// Usage : node tools/render-icons.mjs  (Playwright requis)
import fs from 'fs';
import path from 'path';
const PW = process.env.PLAYWRIGHT || '/Users/evoshifting/Projects/fidzy/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);
const R = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const logo = fs.readFileSync(path.join(R, 'logo.svg'), 'utf8');
const fav = fs.readFileSync(path.join(R, 'favicon.svg'), 'utf8');
const sized = (svg, s) => svg.replace(/width="\d+" height="\d+"/, `width="${s}" height="${s}"`);
const b = await chromium.launch();
async function shot(html, w, h, out) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.setContent(`<html><body style="margin:0;background:transparent">${html}</body></html>`);
  await p.screenshot({ path: path.join(R, out), omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  await p.close();
}
// Icônes d'appli : tuile pleine ; version « maskable » avec marge de sécurité de 20 %
await shot(sized(logo, 192).replace('rx="15"', 'rx="0"'), 192, 192, 'icon-192.png');
await shot(sized(logo, 512).replace('rx="15"', 'rx="0"'), 512, 512, 'icon-512.png');
await shot(`<div style="width:512px;height:512px;background:#0B2545;display:grid;place-items:center">${sized(logo, 330).replace('rx="15"', 'rx="0"')}</div>`, 512, 512, 'icon-maskable-512.png');
await shot(sized(logo, 180).replace('rx="15"', 'rx="0"'), 180, 180, 'apple-touch-icon.png');
await shot(sized(fav, 32), 32, 32, '.favicon-32.png');
await shot(sized(fav, 16), 16, 16, '.favicon-16.png');
// Image de partage 1200 x 630
await shot(`<div style="width:1200px;height:630px;background:#0B2545;display:flex;align-items:center;gap:56px;padding:0 96px;box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">
  ${sized(logo, 260)}
  <div><div style="color:#fff;font-size:76px;font-weight:800;letter-spacing:-.02em;line-height:1.05">Urgence Entraide</div>
  <div style="color:#C9D6EA;font-size:34px;margin-top:18px;line-height:1.3">Demandez ou proposez de l'aide<br>près de chez vous, en cas de crise.</div>
  <div style="color:#F97316;font-size:26px;font-weight:700;margin-top:26px">Inondation · tempête · canicule · incendie</div></div></div>`, 1200, 630, 'og-image.png');
await b.close();
// favicon.ico : conteneur ICO avec deux PNG (16 et 32 px)
const imgs = ['.favicon-16.png', '.favicon-32.png'].map(f => fs.readFileSync(path.join(R, f)));
const head = Buffer.alloc(6 + 16 * imgs.length); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(imgs.length, 4);
let off = head.length;
imgs.forEach((png, i) => { const s = [16, 32][i], e = 6 + 16 * i;
  head.writeUInt8(s, e); head.writeUInt8(s, e + 1); head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(off, e + 12); off += png.length; });
fs.writeFileSync(path.join(R, 'favicon.ico'), Buffer.concat([head, ...imgs]));
['.favicon-16.png', '.favicon-32.png'].forEach(f => fs.unlinkSync(path.join(R, f)));
console.log('icônes, favicon.ico et og-image.png générés');
