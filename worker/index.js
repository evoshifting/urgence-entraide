/* Relais des vigilances officielles pour Urgence Entraide.
   Interroge Vigicrues (API publique, sans clé) et renvoie au site un résumé minuscule :
   nombre de tronçons surveillés et liste de ceux en vigilance jaune, orange ou rouge.
   Pourquoi un relais : Vigicrues n'autorise pas la lecture directe depuis un autre site
   (pas d'en-tête CORS), et une future clé Météo-France doit rester secrète.
   Résultat gardé 15 minutes en cache : au plus 4 appels par heure vers Vigicrues. */

const VIGICRUES = 'https://www.vigicrues.gouv.fr/services/InfoVigiCru.geojson';
const CACHE_S = 900;
const ORIGINES = [
  'https://urgence-entraide.web.app',
  'https://urgence-entraide.firebaseapp.com',
  'https://urgence-entraide-incendie.web.app',
  'https://urgence-entraide-incendie.firebaseapp.com',
  'https://evoshifting.com',
  'http://localhost:8095',
];
const NIVEAUX = { 1: 'vert', 2: 'jaune', 3: 'orange', 4: 'rouge' };

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ORIGINES.includes(origin) ? origin : ORIGINES[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    Vary: 'Origin',
  };
}

async function crues() {
  const r = await fetch(VIGICRUES, { cf: { cacheTtl: CACHE_S, cacheEverything: true }, headers: { 'User-Agent': 'UrgenceEntraide/1.0 (+https://urgence-entraide.web.app)' } });
  if (!r.ok) throw new Error(`Vigicrues HTTP ${r.status}`);
  const geo = await r.json();
  const troncons = (geo.features || []).map(f => f.properties || {});
  const alerte = troncons
    .filter(p => Number(p.NivInfViCr) >= 2)
    .map(p => ({ niveau: NIVEAUX[Number(p.NivInfViCr)] || 'inconnu', nom: String(p.lbentcru || '').trim() }))
    .sort((a, b) => ['rouge', 'orange', 'jaune'].indexOf(a.niveau) - ['rouge', 'orange', 'jaune'].indexOf(b.niveau) || a.nom.localeCompare(b.nom, 'fr'));
  return {
    ok: true,
    source: 'Vigicrues',
    lien: 'https://www.vigicrues.gouv.fr/',
    surveilles: troncons.length,
    rouge: alerte.filter(t => t.niveau === 'rouge').map(t => t.nom),
    orange: alerte.filter(t => t.niveau === 'orange').map(t => t.nom),
    jaune: alerte.filter(t => t.niveau === 'jaune').map(t => t.nom),
  };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    if (request.method !== 'GET') return new Response('Méthode non autorisée', { status: 405, headers: cors(origin) });

    const cache = caches.default;
    const cleCache = new Request(new URL('/v1', request.url).toString());
    let rep = await cache.match(cleCache);
    if (!rep) {
      let corps;
      try { corps = { maj: new Date().toISOString(), crues: await crues() }; }
      catch (e) { corps = { maj: new Date().toISOString(), crues: { ok: false, source: 'Vigicrues', lien: 'https://www.vigicrues.gouv.fr/', erreur: String(e.message || e) } }; }
      rep = new Response(JSON.stringify(corps), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_S}` },
      });
      if (corps.crues.ok) ctx.waitUntil(cache.put(cleCache, rep.clone()));
    }
    const h = new Headers(rep.headers);
    Object.entries(cors(origin)).forEach(([k, v]) => h.set(k, v));
    return new Response(rep.body, { status: rep.status, headers: h });
  },
};
