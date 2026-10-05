/* =====================================================================
   URGENCE ENTRAIDE INCENDIE — app.js
   - Les annonces sont stockées dans une base partagée (Firebase Firestore)
     configurée dans firebase-config.js : TOUS les visiteurs voient TOUTES
     les annonces en temps réel, sans rien faire de spécial.
   - Si firebase-config.js n'est pas configuré (ou si la connexion échoue,
     ex : réseau très dégradé), le site continue de fonctionner en mode
     local de secours (localStorage), comme avant — mais dans ce cas
     chaque appareil ne voit que ses propres annonces + celles reçues par
     lien. Un badge en haut du site indique l'état de la connexion.
   - Le bouton "Partager sur WhatsApp" reste disponible pour donner de la
     visibilité en dehors du site (groupes WhatsApp, etc.), en plus du
     partage automatique via Firestore.
   - Le fil est visible publiquement dès l'arrivée sur le site : aucune
     identification n'est requise pour consulter les annonces. Le
     prénom + téléphone ne sont demandés que dans le formulaire de
     publication (et mémorisés localement pour préremplir la prochaine
     fois).
===================================================================== */

const STORAGE_KEY = 'uei_annonces_v1';
const MINE_KEY = 'uei_mine_v1';
const PAGE_SIZE = 8;

const CATEGORIES = {
  logement:     { label: 'Logement entier', icon: '🏠', svg: 'home' },
  chambre:      { label: "Chambre d'amis", icon: '🛏️', svg: 'bed' },
  accueil_jour: { label: 'Accueil de jour', icon: '☕', svg: 'cup' },
  nourriture:   { label: 'Nourriture / eau', icon: '🍽️', svg: 'food' },
  materiel:     { label: "Matériel d'urgence", icon: '📦', svg: 'box' },
  transport:    { label: 'Transport', icon: '🚗', svg: 'car' },
  autre:        { label: 'Autre', icon: '❔', svg: 'dots' },
};
const ico = (name, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* =====================================================================
   CRISE EN COURS : le seul endroit à modifier pour réactiver le site
   lors d'une prochaine urgence (incendie, inondation, tempête…).
   actif:false affiche le site en veille (pastille grise, sans date).
===================================================================== */
const CRISE = {
  actif: true,
  intitule: 'France · vigilances officielles en direct',
  maj: '05/10',
  titreInfo: 'Aucune alerte rouge ou orange · vigilance jaune pluie-inondation dans le Sud-Est',
  resume: "Au <strong>5 octobre 2026 (6 h)</strong>, Météo-France ne signale <strong>aucune vigilance rouge ou orange</strong> en France. Vigilance jaune <strong>pluie-inondation et orages</strong> : Aude, Hérault, Pyrénées-Orientales, Corse-du-Sud et Haute-Corse. En automne, les épisodes méditerranéens peuvent provoquer des crues soudaines : consultez les cartes en direct avant tout déplacement.",
  note: "Résumé vérifié le 05/10/2026 sur vigilance.meteofrance.fr. Les liens ci-dessus sont mis à jour en continu par les services de l'État.",
  prefecture: { label: 'vigilance.meteofrance.fr', url: 'https://vigilance.meteofrance.fr/fr' },
  liens: [
    { label: 'Vigilance météo en direct (Météo-France)', url: 'https://vigilance.meteofrance.fr/fr' },
    { label: 'Vigilance crues en direct (Vigicrues)', url: 'https://www.vigicrues.gouv.fr/' },
    { label: 'Alertes sur votre téléphone (FR-Alert)', url: 'https://www.fr-alert.gouv.fr/' },
    { label: 'Risques près de chez vous (Géorisques)', url: 'https://www.georisques.gouv.fr/' },
    { label: 'Routes et circulation (Bison Futé)', url: 'https://www.bison-fute.gouv.fr/' },
    { label: 'Catastrophe naturelle : indemnisation (Service-Public)', url: 'https://www.service-public.gouv.fr/particuliers/vosdroits/F3076' },
  ],
  forces: "Pompiers, secouristes, soignants, agents de l'État et des communes, bénévoles : merci.",
  nomPartage: 'Urgence Entraide', // préfixe des messages WhatsApp
  joursAVerifier: 14,             // au-delà, l'annonce invite à vérifier qu'elle est toujours d'actualité
  joursMax: 30,                   // au-delà, l'annonce est masquée (sauf pour son auteur, sur son appareil)
};

const STATUTS = {
  // Clé interne "pourvu" conservée pour rester compatible avec les règles de
  // sécurité Firestore déjà publiées (qui autorisent explicitement cette
  // valeur) — seul le libellé affiché change, en "Clôturé" plus clair.
  ouvert: { label: 'Ouvert', icon: '🟢' },
  pause:  { label: 'En pause', icon: '⏸️' },
  pourvu: { label: 'Clôturé', icon: '🔒' },
};

/* =====================================================================
   STOCKAGE : Firestore partagé, avec repli local automatique
===================================================================== */

let cache = [];          // liste actuellement affichée (source de vérité pour le rendu)
let db = null;
let analytics = null;

// Utilitaire de log sécurisé : n'échoue jamais, même si Analytics n'a pas
// pu s'initialiser (bloqueur de pub...) — un simple no-op dans ce cas.
function logEvent(name, params) {
  try {
    if (analytics) analytics.logEvent(name, params);
  } catch (err) { /* silencieux, volontairement */ }
}
let firebaseReady = false;

function loadLocalCache() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}
function saveLocalCache(items) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch {}
}

/* =====================================================================
   MODE DÉMONSTRATION : 30 annonces fictives, uniquement dans ce navigateur.
   Rien n'est écrit dans Firestore ; publication, partage WhatsApp et import
   par lien sont désactivés tant que la démo est active. Numéros pris dans la
   tranche 06 39 98 xx xx que l'ARCEP réserve aux œuvres de fiction.
   Activation : bouton « Voir une démo » ou lien ?demo=1.
===================================================================== */
const DEMO_SEED = [
  // [type, catégorie, commune, quartier, lat, lon, description, prénom, il y a (heures), statut]
  ['besoin', 'logement', 'La Teste-de-Buch 33260', 'Cazaux', 44.5367, -1.1514, "Évacués de Cazaux cette nuit avec nos deux enfants (4 et 9 ans). Nous cherchons un logement pour une semaine, même petit.", 'Julie', 2],
  ['offre', 'chambre', 'Mérignac 33700', 'Capeyron', 44.8510, -0.6200, "Chambre d'amis libre avec salle d'eau, lit double. Accueil possible dès ce soir pour 1 à 2 personnes, sans limite de durée.", 'Philippe', 3],
  ['besoin', 'transport', 'Biscarrosse 40600', 'Biscarrosse-Plage', 44.4475, -1.2500, "Ma mère de 82 ans doit rejoindre ma sœur à Bordeaux, elle ne conduit pas. Quelqu'un fait-il le trajet demain ?", 'Sandrine', 4],
  ['offre', 'nourriture', 'Gujan-Mestras 33470', 'Port de Larros', 44.6356, -1.0711, "Restaurant fermé pendant les évacuations : nous préparons 40 repas chauds par jour pour les familles et les bénévoles, à emporter dès 12 h.", 'Karim', 5],
  ['offre', 'accueil_jour', 'Arcachon 33120', 'Ville d\'Hiver', 44.6586, -1.1689, "Maison ouverte en journée : douche, machine à laver, recharge de téléphones, café. De 9 h à 19 h, sonnez au portail vert.", 'Hélène', 6],
  ['besoin', 'materiel', 'Lège-Cap-Ferret 33950', 'Claouey', 44.7500, -1.1830, "Partis sans rien : besoin de vêtements pour un garçon de 6 ans (taille 116) et d'un chargeur USB-C.", 'Thomas', 7],
  ['offre', 'logement', 'Pessac 33600', 'Saige', 44.7920, -0.6300, "Studio meublé vide jusqu'à fin septembre, rez-de-chaussée, accessible en fauteuil. Gratuit pour une personne ou un couple sinistré.", 'Nadia', 8],
  ['offre', 'transport', 'Bordeaux 33000', 'Chartrons', 44.8550, -0.5700, "Je fais Bordeaux ⇄ bassin d'Arcachon tous les jours cette semaine, 3 places libres dans un monospace. Animaux acceptés.", 'Benoît', 9],
  ['besoin', 'chambre', 'Sanguinet 40460', 'Bourg', 44.4836, -1.0750, "Infirmière en renfort à l'hôpital d'Arcachon, je cherche une chambre près du bassin pour 10 jours. Horaires de nuit.", 'Camille', 10],
  ['offre', 'materiel', 'Talence 33400', 'Forum', 44.8090, -0.5890, "Trois lits de camp, des sacs de couchage et une dizaine de couvertures à donner. Je peux livrer dans la métropole.", 'Antoine', 12],
  ['besoin', 'nourriture', 'Parentis-en-Born 40160', 'Centre', 44.3519, -1.0703, "Centre d'hébergement municipal : il manque des petits pots et du lait infantile 2e âge pour 6 bébés.", 'Mairie (Laure)', 13],
  ['offre', 'chambre', 'Le Bouscat 33110', 'Barrière du Médoc', 44.8650, -0.5995, "Deux chambres à l'étage, jardin clos : idéal pour une famille avec un chien. Disponible tout le mois.", 'Isabelle', 15],
  ['besoin', 'logement', 'Biscarrosse 40600', 'Navarrosse', 44.4300, -1.1600, "Couple de retraités, maison inaccessible pour plusieurs jours. Nous cherchons un hébergement de plain-pied, nous avons un petit chat.", 'Gérard', 18],
  ['offre', 'accueil_jour', 'Andernos-les-Bains 33510', 'Centre', 44.7450, -1.1036, "Salle paroissiale ouverte aux évacués en journée : canapés, jeux pour enfants, Wi-Fi, boissons chaudes.", 'Père Michel', 20],
  ['offre', 'nourriture', 'Libourne 33500', 'Bastide', 44.9150, -0.2436, "Épicerie solidaire : colis de produits frais et d'hygiène à retirer gratuitement, sur simple appel.", 'Fatima', 22],
  ['besoin', 'autre', 'Mios 33380', 'Lacanau-de-Mios', 44.6053, -0.9361, "Nous devons faire garder deux chevaux évacués pendant une semaine. Pré ou box dans le secteur ?", 'Élodie', 26],
  ['offre', 'logement', 'Cestas 33610', 'Réjouit', 44.7428, -0.6811, "Mobil-home équipé sur notre terrain, 4 couchages, eau et électricité. Pour une famille, aussi longtemps que nécessaire.", 'Stéphane', 30],
  ['besoin', 'transport', 'Gujan-Mestras 33470', 'La Hume', 44.6420, -1.1120, "Besoin d'un véhicule pour déménager quelques meubles chez un proche à Mérignac, samedi matin.", 'Lucas', 34],
  ['offre', 'transport', 'Saint-Médard-en-Jalles 33160', 'Hastignan', 44.8964, -0.7194, "Camionnette 12 m³ disponible avec chauffeur le week-end pour déménagements d'urgence.", 'Yannick', 40],
  ['offre', 'materiel', 'Blanquefort 33290', 'Caychac', 44.9106, -0.6375, "Collecte de vêtements enfants 0-12 ans triés par taille, à venir chercher ou livrés sur le bassin.", 'Association Les Petits Pas', 46],
  ['besoin', 'accueil_jour', 'Arcachon 33120', 'Aiguillon', 44.6600, -1.1500, "Je dors dans ma voiture depuis l'évacuation : un endroit pour prendre une douche et laver mon linge me rendrait service.", 'Marc', 52],
  ['offre', 'chambre', 'Bègles 33130', 'Terres Neuves', 44.8086, -0.5478, "Chambre au calme dans un appartement, idéale pour un soignant ou un pompier en renfort.", 'Clara', 60, 'pause'],
  ['besoin', 'materiel', 'La Teste-de-Buch 33260', 'Pyla-sur-Mer', 44.6200, -1.2000, "Recherche un fauteuil roulant pliant pour mon père, le sien est resté dans la maison évacuée.", 'Nathalie', 70],
  ['offre', 'nourriture', 'Mérignac 33700', 'Arlac', 44.8300, -0.6300, "Je cuisine en grande quantité : plats végétariens et sans porc à récupérer chaque soir.", 'Samira', 80],
  ['besoin', 'logement', 'Lège-Cap-Ferret 33950', 'Le Canon', 44.6900, -1.2400, "Famille de 5, maison détruite. Cherche location ou prêt de logement pour deux mois minimum.", 'Olivier', 96, 'pourvu'],
  ['offre', 'logement', 'Bordeaux 33800', 'Saint-Jean', 44.8250, -0.5560, "Appartement T2 prêté gratuitement pendant mon absence, du 1er au 31 du mois.", 'Pauline', 120],
  ['besoin', 'chambre', 'Mont-de-Marsan 40000', 'Saint-Médard', 43.8900, -0.5000, "Étudiante évacuée de Biscarrosse, je cherche une chambre près du campus pour la rentrée.", 'Inès', 200],
  ['offre', 'accueil_jour', 'Talence 33400', 'Thouars', 44.7950, -0.5870, "Maison de quartier : aide aux démarches d'assurance et de relogement, mardi et jeudi après-midi.", 'Collectif Thouars', 380],
  ['besoin', 'nourriture', 'Biscarrosse 40600', 'Bourg', 44.3942, -1.1636, "Banque alimentaire locale : besoin de bénévoles et de denrées non périssables.", 'Restos du Bourg (Paul)', 420],
  ['offre', 'materiel', 'Pessac 33600', 'Cap de Bos', 44.8000, -0.6600, "Déshumidificateurs et nettoyeur haute pression à prêter pour remettre les maisons en état.", 'Hugo', 460, 'pourvu'],
];
function buildDemoAnnonces() {
  const now = Date.now();
  return DEMO_SEED.map(([type, categorie, commune, quartier, lat, lon, description, contactPrenom, heures, statut], i) => ({
    id: `demo-${i + 1}`, demo: true, type, categorie, commune, quartier, lat, lon, description, contactPrenom,
    contactTel: `06 39 98 00 ${String(10 + i).padStart(2, '0')}`,
    createdAt: now - heures * 3600e3, statut: statut || 'ouvert',
  }));
}
let demoMode = (() => {
  try { return new URLSearchParams(location.search).get('demo') === '1' || sessionStorage.getItem('uei_demo') === '1'; }
  catch { return false; }
})();
let demoAnnonces = demoMode ? buildDemoAnnonces() : [];

function readAll() { return demoMode ? demoAnnonces : cache; }

function getMineIds() {
  try { return new Set(JSON.parse(localStorage.getItem(MINE_KEY)) || []); }
  catch { return new Set(); }
}
function markMine(id) {
  const s = getMineIds();
  s.add(id);
  localStorage.setItem(MINE_KEY, JSON.stringify([...s]));
}
function makeId() {
  return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function setSyncStatus(state) {
  const status = el('sync-status');
  const map = {
    connecting:   'Connexion au fil partagé…',
    online:       'Partagé en direct avec tous les visiteurs',
    error:        'Fil partagé momentanément indisponible, nouvelle tentative en cours',
    'offline-local': 'Mode local : les annonces restent sur cet appareil',
  };
  status.textContent = map[state] || '';
  status.setAttribute('data-state', state);
}

const POLL_INTERVAL_MS = 12000;
// Fenêtre de temps dans laquelle une annonce/un message locale(e) peut
// encore être considéré(e) comme "en attente de synchronisation" plutôt
// que "supprimé(e) intentionnellement depuis" (voir garde-fous plus bas).
const MIGRATION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
let pollTimer = null;
let migrated = false;
let localBeforeSync = [];

// =====================================================================
// SONDAGE PÉRIODIQUE (remplace l'ancienne écoute temps réel onSnapshot)
// -----------------------------------------------------------------------
// Diagnostic établi le 24/07 : une lecture ponctuelle (.get()) obtient
// systématiquement une confirmation du serveur (en ~25-30s selon le
// réseau), alors que l'écoute persistante (.onSnapshot()) ne s'est JAMAIS
// confirmée sur aucun appareil testé (Mac/iPhone, Chrome/Safari, wifi/4G),
// avec ou sans réglage de transport particulier. Plutôt que de continuer à
// deviner pourquoi les connexions persistantes échouent dans cet
// environnement, on s'appuie sur ce qui est prouvé fonctionner : des
// lectures ponctuelles répétées. Contrepartie assumée : ce n'est plus du
// vrai "temps réel" (délai de quelques secondes à ~12s), et le coût en
// lectures Firestore est plus élevé qu'un vrai listener à grande échelle.
// =====================================================================

async function pollFirestore(isFirstPoll) {
  try {
    const snap = await db.collection('annonces').orderBy('createdAt', 'desc').limit(200).get();
    console.info(`[UEI][debug] sondage reçu : ${snap.docs.length} document(s), fromCache=${snap.metadata.fromCache}`);
    cache = snap.docs.map(d => d.data());
    saveLocalCache(cache);
    firebaseReady = true;
    setSyncStatus('online');

    // Migration ascendante (une seule fois, après le tout premier sondage
    // réussi) : toute annonce créée localement avant que Firestore ne soit
    // joignable est renvoyée vers le fil partagé.
    //
    // ⚠️ GARDE-FOUS CRITIQUES (bug corrigé le 27/07) : sans restriction,
    // cette migration ressuscitait n'importe quelle annonce supprimée par
    // un modérateur, dès qu'un appareil ayant encore l'ancienne version en
    // cache local rechargeait la page — le sondage ne la trouvait plus sur
    // le serveur, la prenait pour une "orpheline jamais synchronisée", et
    // la renvoyait. On ne migre donc désormais QUE les annonces qui sont
    // À LA FOIS (a) marquées "mienne" sur CET appareil (publiées ici, pas
    // juste vues) ET (b) créées très récemment — le vrai scénario legitime
    // étant "je viens de publier hors-ligne, ça n'a pas encore synchronisé".
    // Une annonce plus ancienne, même absente du serveur, est supposée
    // avoir été supprimée intentionnellement, jamais réinjectée.
    if (!migrated) {
      migrated = true;
      const knownIds = new Set(cache.map(a => a.id));
      const mineIds = getMineIds();
      const orphans = localBeforeSync.filter(a =>
        !knownIds.has(a.id) && mineIds.has(a.id) && (Date.now() - a.createdAt) < MIGRATION_WINDOW_MS
      );
      if (orphans.length) {
        console.info(`[UEI] ${orphans.length} annonce(s) locale(s) migrée(s) vers le fil partagé.`);
        cache = [...orphans, ...cache].sort((a, b) => b.createdAt - a.createdAt);
        saveLocalCache(cache);
        orphans.forEach(a => {
          db.collection('annonces').doc(a.id).set(a, { merge: true })
            .catch((err) => console.warn('[UEI] Échec migration annonce locale', a.id, err));
        });
      }
    }

    renderFeed();
    return true;
  } catch (err) {
    console.warn('[UEI] Échec de synchronisation Firestore (nouvelle tentative au prochain sondage)', err);
    if (!firebaseReady) setSyncStatus('error');
    return false;
  }
}

function initSync() {
  return new Promise((resolve) => {
    cache = loadLocalCache();
    localBeforeSync = cache; // conservé pour la migration ascendante
    renderFeed();

    const cfg = window.UEI_FIREBASE_CONFIG;
    const isConfigured = cfg && cfg.apiKey && cfg.apiKey !== 'REMPLACE_MOI';
    if (!isConfigured || typeof firebase === 'undefined') {
      setSyncStatus('offline-local');
      resolve();
      return;
    }

    setSyncStatus('connecting');
    try {
      firebase.initializeApp(cfg);
      db = firebase.firestore();
    } catch (err) {
      console.warn('[UEI] Firebase indisponible, mode local de secours', err);
      setSyncStatus('offline-local');
      resolve();
      return;
    }

    // Analytics est optionnel et fréquemment bloqué (bloqueurs de pub,
    // navigateurs orientés vie privée) — on l'active "en bonus", sans
    // jamais laisser un échec ici perturber le reste du site (annonces,
    // synchronisation...), qui doit continuer à fonctionner sans lui.
    try {
      if (typeof firebase.analytics === 'function' && cfg.measurementId) {
        analytics = firebase.analytics();
      }
    } catch (err) {
      console.warn('[UEI] Analytics indisponible (bloqueur de pub ?), pas grave, le reste du site continue', err);
    }

    // Premier sondage : on attend son résultat (max 4s, le contenu local
    // est déjà affiché entre-temps) avant de laisser l'app continuer,
    // pour pouvoir importer un lien partagé une fois qu'on sait si on est
    // en ligne ou non.
    let settled = false;
    const settleOnce = () => { if (!settled) { settled = true; clearTimeout(fallbackTimeoutId); resolve(); } };
    const fallbackTimeoutId = setTimeout(settleOnce, 4000);
    if (typeof fallbackTimeoutId.unref === 'function') fallbackTimeoutId.unref();
    pollFirestore(true).finally(settleOnce);

    // Sondage périodique en arrière-plan.
    clearInterval(pollTimer);
    pollTimer = setInterval(() => pollFirestore(false), POLL_INTERVAL_MS);
    // .unref() : en Node.js (tests automatisés), un setInterval actif
    // empêche le process de se terminer naturellement — sans incidence en
    // navigateur, où cette méthode n'existe pas (d'où la vérification).
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  });
}

function scheduleQuickSync() {
  // Après une écriture, on redemande un sondage un peu plus tôt que le
  // prochain cycle automatique (12s), pour que la mise à jour se
  // propage plus vite sans pour autant spammer Firestore de requêtes.
  if (db) {
    const t = setTimeout(() => pollFirestore(false), 3000);
    if (typeof t.unref === 'function') t.unref();
  }
}

function addAnnonce(data) {
  const annonce = { id: makeId(), createdAt: Date.now(), statut: 'ouvert', ...data };
  // Affichage optimiste immédiat, avant même la confirmation du serveur
  cache = [annonce, ...cache];
  saveLocalCache(cache);
  renderFeed();
  logEvent('annonce_publiee', { type: annonce.type, categorie: annonce.categorie });
  // On tente l'écriture dès que `db` existe (Firebase configuré) : une
  // écriture .set() ponctuelle s'est révélée fiable dans nos tests
  // (contrairement à l'écoute temps réel), même si elle peut prendre
  // plusieurs secondes à se confirmer sur certains réseaux.
  if (db) {
    db.collection('annonces').doc(annonce.id).set(annonce).then(scheduleQuickSync).catch((err) => {
      console.warn('[UEI] Échec de publication partagée, restera visible localement seulement', err);
      showToast("Publiée localement (connexion au fil partagé indisponible)");
    });
  }
  return annonce;
}
function setStatut(id, statut) {
  cache = cache.map(a => a.id === id ? { ...a, statut } : a);
  saveLocalCache(cache);
  renderFeed();
  if (db) {
    // Nécessite que les règles Firestore autorisent la mise à jour du
    // champ "statut" (voir firebase-config.js). Si les règles n'ont pas
    // été mises à jour, cet appel échoue silencieusement et le nouveau
    // statut reste affiché localement seulement — pas de blocage.
    db.collection('annonces').doc(id).update({ statut }).then(scheduleQuickSync).catch((err) => {
      console.warn('[UEI] Échec mise à jour du statut côté serveur (règles Firestore à mettre à jour ?)', err);
    });
  }
}
function deleteAnnonce(id) {
  cache = cache.filter(a => a.id !== id);
  saveLocalCache(cache);
  if (db) {
    db.collection('annonces').doc(id).delete().then(scheduleQuickSync)
      .catch((err) => console.warn('[UEI] Échec suppression partagée', err));
  }
}
function importAnnonce(annonce) {
  if (cache.some(a => a.id === annonce.id)) return false; // déjà connue
  cache = [annonce, ...cache];
  saveLocalCache(cache);
  if (db) {
    db.collection('annonces').doc(annonce.id).set(annonce, { merge: true }).then(scheduleQuickSync)
      .catch((err) => console.warn('[UEI] Échec import partagé', err));
  }
  return true;
}

/* =====================================================================
   ÉTAT
===================================================================== */

let filterType = 'all';
let filterCat = 'all';
let filterZone = 'all';
let searchQuery = '';
let sortOrder = 'recent';
let currentPage = 1;
let pendingShareData = null;
let viewMode = 'feed'; // 'feed' | 'map'
let hideResolved = false;
let userPos = null; // { lat, lon } une fois la géolocalisation acceptée
let leafletMap = null;
let leafletMarkersLayer = null;

const el = (id) => {
  const found = document.getElementById(id);
  if (found) return found;
  // Élément introuvable : on log clairement (aide au diagnostic) et on renvoie
  // un élément factice jamais inséré dans le DOM, pour que les .addEventListener /
  // .classList / .value appelés dessus ne fassent PAS planter tout le script.
  // Sans ce filet, un seul id manquant (ex: cache navigateur obsolète après une
  // mise à jour) casserait TOUS les boutons de la page, pas seulement celui
  // concerné — c'est le bug le plus probable derrière un "plus rien ne marche".
  console.warn(`[Urgence Entraide Incendie] Élément #${id} introuvable dans la page. Si vous venez de mettre à jour le site, faites un rechargement forcé (Ctrl/Cmd + Maj + R) pour vider le cache du navigateur.`);
  return document.createElement('div');
};

const importBanner = el('import-banner');
const statsBar = el('stats-bar');

/* =====================================================================
   DÉTECTION NAVIGATEUR INTÉGRÉ (WhatsApp, Instagram, Facebook, LINE...)
   -----------------------------------------------------------------------
   Diagnostic établi le 24/07 : Firestore ne fonctionne pas de façon
   fiable dans ces navigateurs bridés (webviews d'applications), même
   quand Safari/Chrome classiques fonctionnent normalement sur le même
   appareil — confirmé en testant depuis le navigateur intégré de
   WhatsApp (visible via "◀ WhatsApp" en haut de l'écran) : aucune
   confirmation serveur obtenue, même après 20+ secondes, alors que la
   même page dans Safari classique finit par réussir. Comme le site est
   volontairement partagé via WhatsApp, ce cas n'est PAS un cas limite —
   c'est le chemin d'arrivée principal pour beaucoup de visiteurs, d'où
   cette bannière plutôt qu'un correctif silencieux (qui n'existe pas :
   il n'y a pas d'API JS pour forcer l'ouverture du vrai navigateur
   depuis une webview iOS/Android).
===================================================================== */

function detectInAppBrowser() {
  const ua = navigator.userAgent || '';
  // Signatures connues et fiables (Android inclut le nom de l'appli dans l'UA)
  if (/\b(WhatsApp|FBAN|FBAV|Instagram|Line\/|MicroMessenger|Twitter|TikTok)\b/i.test(ua)) return true;
  // Heuristique iOS : les navigateurs légitimes (Safari, Chrome iOS, Firefox
  // iOS) ont toujours un jeton distinctif dans l'UA (Safari/, CriOS/, FxiOS/,
  // EdgiOS/) ; beaucoup de webviews d'applications (dont WhatsApp iOS) ne
  // l'ont pas, tout en se présentant comme un iPhone/iPad WebKit classique.
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  const hasKnownBrowserToken = /Safari\/|CriOS\/|FxiOS\/|EdgiOS\/|OPiOS\//.test(ua);
  if (isIOS && !hasKnownBrowserToken) return true;
  return false;
}

function initInAppBannerCheck() {
  const KEY = 'uei_inapp_banner_dismissed';
  if (!detectInAppBrowser() || sessionStorage.getItem(KEY) === '1') return;
  const banner = el('inapp-banner');
  banner.classList.remove('hidden');
  el('btn-close-inapp-banner').addEventListener('click', () => {
    banner.classList.add('hidden');
    try { sessionStorage.setItem(KEY, '1'); } catch {}
  });
}
initInAppBannerCheck();

const btnDemander = el('btn-demander');
const btnProposer = el('btn-proposer');
const modalBackdrop = el('modal-backdrop');
const modalTitle = el('modal-title');
const btnCloseModal = el('btn-close-modal');
const annonceForm = el('annonce-form');
const formError = el('form-error');

const shareModalBackdrop = el('share-modal-backdrop');
const btnShareWhatsappNow = el('btn-share-whatsapp-now');
const btnCloseShareModal = el('btn-close-share-modal');

const searchBox = el('search-box');
const sortSelect = el('sort-select');
const facetType = el('facet-type');
const facetCat = el('facet-cat');
const facetZone = el('facet-zone');

const feed = el('feed');
const emptyState = el('empty-state');
const resultCount = el('result-count');
const pagination = el('pagination');
const toast = el('toast');
const btnForgetMe = el('btn-forget-me');

const btnViewFeed = el('btn-view-feed');
const btnViewMap = el('btn-view-map');
const mapView = el('map-view');
const mapContainer = el('map-container');
const btnGeoloc = el('btn-geoloc');
const chkHideResolved = el('chk-hide-resolved');

// Refonte filtres : panneau partagé (dropdown desktop / tiroir mobile),
// déclencheurs, options dupliquées dans le tiroir mobile (voir plus bas
// pour la logique de synchronisation avec leurs équivalents desktop).
const btnToggleCat = el('btn-toggle-cat');
const btnToggleZone = el('btn-toggle-zone');
const btnOpenFilters = el('btn-open-filters');
const btnCloseFiltersDesktop = el('btn-close-filters-desktop');
const btnResetFilters = el('btn-reset-filters');
const btnApplyFilters = el('btn-apply-filters');
const btnGeolocMobile = el('btn-geoloc-mobile');
const chkHideResolvedMobile = el('chk-hide-resolved-mobile');
const filtersPanel = el('filters-panel');
const filtersOverlay = el('filters-overlay');
const filtersSectionCat = el('filters-section-cat');
const filtersSectionZone = el('filters-section-zone');
const zoneSearchBox = el('zone-search-box');
const badgeCat = el('badge-cat');
const badgeZone = el('badge-zone');
const badgeFilters = el('badge-filters');
const filtersResultCount = el('filters-result-count');
const filtersResultPlural = el('filters-result-plural');

// Carte "Info officielle" repliable
const infoCard = el('info-card');
const infoToggle = el('info-toggle');
const infoChevron = el('info-chevron');

/* =====================================================================
   IDENTITÉ (mémorisée pour préremplir le formulaire, jamais bloquante)
===================================================================== */

function getIdentity() {
  const prenom = localStorage.getItem('uei_prenom');
  const tel = localStorage.getItem('uei_tel');
  return prenom && tel ? { prenom, tel } : null;
}
function setIdentity(prenom, tel) {
  localStorage.setItem('uei_prenom', prenom);
  localStorage.setItem('uei_tel', tel);
}

btnForgetMe.addEventListener('click', () => {
  if (!confirm("Effacer votre prénom et votre téléphone mémorisés, et l'historique de vos annonces sur cet appareil ? (Vos annonces déjà publiées resteront visibles dans le fil, mais vous ne pourrez plus les supprimer depuis cet appareil.)")) return;
  localStorage.removeItem('uei_prenom');
  localStorage.removeItem('uei_tel');
  localStorage.removeItem(MINE_KEY);
  showToast('Informations locales effacées');
  renderFeed();
});

/* =====================================================================
   "GÉRER UNE ANNONCE" — retrouve la gestion (statut/suppression) d'une
   annonce publiée depuis un autre appareil, ou une fenêtre de navigation
   privée entre-temps fermée (la liste "mes annonces" est alors perdue,
   irrémédiablement, puisqu'elle vit dans le stockage local de cette
   fenêtre-là uniquement). Vérification par numéro de téléphone : c'est
   déjà la donnée publique affichée sur l'annonce elle-même, donc ça
   n'expose rien de nouveau — simplement pratique, pas une authentification
   forte.
===================================================================== */

const btnManageMine = el('btn-manage-mine');
const manageModalBackdrop = el('manage-modal-backdrop');
const btnCloseManageModal = el('btn-close-manage-modal');
const manageForm = el('manage-form');
const manageTelInput = el('manage-tel');
const manageError = el('manage-error');

function openManageModal() {
  manageForm.reset();
  manageError.classList.add('hidden');
  manageModalBackdrop.classList.remove('hidden');
}
function closeManageModal() { manageModalBackdrop.classList.add('hidden'); }

btnManageMine.addEventListener('click', openManageModal);
btnCloseManageModal.addEventListener('click', closeManageModal);
manageModalBackdrop.addEventListener('click', (e) => { if (e.target === manageModalBackdrop) closeManageModal(); });

manageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const target = cleanTel(manageTelInput.value);
  if (!target) return;
  const matches = cache.filter(a => cleanTel(a.contactTel) === target);
  if (!matches.length) {
    manageError.classList.remove('hidden');
    return;
  }
  manageError.classList.add('hidden');
  matches.forEach(a => markMine(a.id));
  closeManageModal();
  renderFeed();
  showToast(`${matches.length} annonce${matches.length > 1 ? 's' : ''} retrouvée${matches.length > 1 ? 's' : ''} — gérable${matches.length > 1 ? 's' : ''} depuis le fil`);
});

/* =====================================================================
   UTILITAIRES
===================================================================== */

function timeAgo(ts) {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return "à l'instant";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `il y a ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `il y a ${diffH} h`;
  return `il y a ${Math.floor(diffH / 24)} j`;
}
function cleanTel(tel) { return (tel || '').replace(/[^\d+]/g, ''); }
function escapeHTML(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function lieuComplet(a) {
  return a.quartier ? `${a.commune} — ${a.quartier}` : a.commune;
}

/* =====================================================================
   CHARGEMENT À LA DEMANDE (Leaflet) — pour ne pas alourdir le premier
   chargement de la page avec une bibliothèque dont la plupart des
   visiteurs ne se serviront jamais (carte).
===================================================================== */

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Échec chargement ${src}`));
    document.head.appendChild(s);
  });
}
function loadStylesheetOnce(href) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`link[href="${href}"]`)) { resolve(); return; }
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.onload = () => resolve();
    l.onerror = () => reject(new Error(`Échec chargement ${href}`));
    document.head.appendChild(l);
  });
}
function hasCoords(a) {
  return typeof a.lat === 'number' && typeof a.lon === 'number';
}
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* =====================================================================
   WHATSAPP
===================================================================== */

function whatsappMessage(a) {
  const cat = (CATEGORIES[a.categorie] || { label: a.categorie }).label;
  const action = a.type === 'besoin' ? 'Recherche' : 'Offre';
  const link = buildShareLink(a);
  return `[${CRISE.nomPartage}] ${action} · ${cat}\n${a.description}\n— ${a.contactPrenom}, ${lieuComplet(a)} · 📞 ${a.contactTel}\n👉 ${link}`;
}
function whatsappLink(a) {
  return `https://wa.me/?text=${encodeURIComponent(whatsappMessage(a))}`;
}

/* =====================================================================
   FACETTES : type / catégorie / zone, avec comptage dynamique
   (comptage "à l'exclusion de la dimension courante", comme un vrai
   moteur de recherche à facettes : chaque compteur reflète le nombre
   de résultats qu'on obtiendrait EN CHOISISSANT cette option, compte
   tenu des AUTRES filtres déjà actifs).
===================================================================== */

/* =====================================================================
   RECHERCHE — tolérance aux fautes de frappe façon Algolia/Elasticsearch
   -----------------------------------------------------------------------
   Règles appliquées (approximation légère, sans vrai moteur de recherche
   côté serveur puisque le site est 100% statique) :
   1. Insensible aux accents et à la casse ("café" trouve "cafe").
   2. Recherche par mot : chaque mot tapé doit correspondre à AU MOINS un
      mot de l'annonce (description, ville, quartier, catégorie).
   3. Correspondance exacte en sous-chaîne toujours acceptée en priorité
      ("chambre" trouve "chambres").
   4. Tolérance aux fautes de frappe pour les mots de 4 lettres ou plus :
      1 caractère d'écart toléré (ajout/suppression/substitution) pour les
      mots de 4 à 7 lettres, 2 caractères pour les mots plus longs — ce
      sont exactement les seuils par défaut d'Algolia (typoTolerance).
      Les mots de moins de 4 lettres n'ont aucune tolérance (trop de
      faux positifs sinon, ex. "lit" ↔ "lot").
===================================================================== */

function normalizeText(s) {
  return (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}

function wordMatchesFuzzy(hayWord, qWord) {
  if (hayWord.includes(qWord)) return true;
  if (qWord.length < 4) return false;
  const maxDist = qWord.length <= 7 ? 1 : 2;
  if (Math.abs(hayWord.length - qWord.length) <= maxDist && levenshtein(hayWord, qWord) <= maxDist) return true;
  return false;
}

function matchesSearch(a, q) {
  if (!q) return true;
  const hay = normalizeText(`${a.description} ${a.commune} ${a.quartier || ''} ${(CATEGORIES[a.categorie] || {}).label || ''}`);
  const qWords = normalizeText(q).split(/[^a-z0-9]+/).filter(Boolean);
  if (!qWords.length) return true;
  const hayWords = hay.split(/[^a-z0-9]+/).filter(Boolean);
  return qWords.every(qw => hay.includes(qw) || hayWords.some(hw => wordMatchesFuzzy(hw, qw)));
}

function filteredExcept(list, exceptDim) {
  return list.filter(a => {
    if (exceptDim !== 'type' && filterType !== 'all' && a.type !== filterType) return false;
    if (exceptDim !== 'cat' && filterCat !== 'all' && a.categorie !== filterCat) return false;
    if (exceptDim !== 'zone' && filterZone !== 'all' && a.commune !== filterZone) return false;
    return true;
  });
}

function facetRow(label, count, active, attrs, disableEmpty = false) {
  const off = disableEmpty && count === 0 && !active ? ' disabled' : '';
  return `<button ${attrs} class="facet-row" data-active="${active}"${off}>
    <span>${label}</span><span class="facet-count">${count}</span>
  </button>`;
}

function renderFacets(all, searchFiltered) {
  // -- Type --
  const byType = filteredExcept(searchFiltered, 'type');
  const cBesoin = byType.filter(a => a.type === 'besoin').length;
  const cOffre = byType.filter(a => a.type === 'offre').length;
  facetType.innerHTML =
    facetRow('Tout', byType.length, filterType === 'all', `data-filter-type="all"`) +
    facetRow('Besoins', cBesoin, filterType === 'besoin', `data-filter-type="besoin"`) +
    facetRow('Offres', cOffre, filterType === 'offre', `data-filter-type="offre"`);

  // -- Catégorie --
  const byCat = filteredExcept(searchFiltered, 'cat');
  facetCat.innerHTML =
    facetRow('Toutes catégories', byCat.length, filterCat === 'all', `data-filter-cat="all"`) +
    Object.entries(CATEGORIES).map(([key, c]) =>
      facetRow(`${ico(c.svg)}${c.label}`, byCat.filter(a => a.categorie === key).length, filterCat === key, `data-filter-cat="${key}"`, true)
    ).join('');

  // -- Zone (dynamique, construite à partir des communes réellement utilisées) --
  const byZone = filteredExcept(searchFiltered, 'zone');
  const zones = [...new Set(all.map(a => a.commune))].sort((a, b) => a.localeCompare(b, 'fr'));
  facetZone.innerHTML =
    facetRow('Toutes les communes', byZone.length, filterZone === 'all', `data-filter-zone="all"`) +
    zones.map(z => facetRow(escapeHTML(z), byZone.filter(a => a.commune === z).length, filterZone === z, `data-filter-zone="${escapeHTML(z)}" data-zone-label="${escapeHTML(normalizeText(z))}"`)).join('');
  // Au-delà d'une poignée de communes (typiquement dès qu'il y a plusieurs
  // dizaines d'annonces réparties sur le territoire), une liste plate
  // devient difficile à parcourir : on affiche alors un champ de recherche
  // qui filtre la liste en direct (voir listener plus bas, attaché une
  // seule fois puisque le champ lui-même n'est jamais reconstruit).
  if (zoneSearchBox) zoneSearchBox.classList.toggle('hidden', zones.length <= 8);

  facetType.querySelectorAll('[data-filter-type]').forEach(btn => {
    btn.addEventListener('click', () => { filterType = btn.getAttribute('data-filter-type'); currentPage = 1; renderFeed(); });
  });
  facetCat.querySelectorAll('[data-filter-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      filterCat = btn.getAttribute('data-filter-cat'); currentPage = 1; renderFeed();
      if (isDesktopFilters()) closeFiltersPanel(); // sur desktop, choisir referme le dropdown ; sur mobile, on laisse choisir cat+zone avant de fermer
    });
  });
  facetZone.querySelectorAll('[data-filter-zone]').forEach(btn => {
    btn.addEventListener('click', () => {
      filterZone = btn.getAttribute('data-filter-zone'); currentPage = 1; renderFeed();
      if (isDesktopFilters()) closeFiltersPanel();
    });
  });

  // Badges de filtres actifs (bouton Catégorie/Zone desktop + bouton Filtres mobile)
  const catActive = filterCat !== 'all';
  const zoneActive = filterZone !== 'all';
  const activeCount = (catActive ? 1 : 0) + (zoneActive ? 1 : 0) + (hideResolved ? 1 : 0);
  if (badgeCat) { badgeCat.textContent = catActive ? '1' : ''; badgeCat.classList.toggle('hidden', !catActive); }
  if (badgeZone) { badgeZone.textContent = zoneActive ? '1' : ''; badgeZone.classList.toggle('hidden', !zoneActive); }
  if (badgeFilters) { badgeFilters.textContent = activeCount ? String(activeCount) : ''; badgeFilters.classList.toggle('hidden', !activeCount); }
}

/* =====================================================================
   TABLEAU DE BORD
===================================================================== */

function renderStats(all) {
  const actives = all.filter(a => (a.statut || 'ouvert') === 'ouvert');
  const offres = actives.filter(a => a.type === 'offre').length;
  const besoins = actives.filter(a => a.type === 'besoin').length;
  statsBar.innerHTML = `
    <span class="s-give"><b>${offres}</b> offre${offres > 1 ? 's' : ''} disponible${offres > 1 ? 's' : ''}</span>
    <span class="s-need"><b>${besoins}</b> besoin${besoins > 1 ? 's' : ''} en attente</span>`;
}

/* =====================================================================
   CARTES
===================================================================== */

function cardHTML(a) {
  const cat = CATEGORIES[a.categorie] || { label: a.categorie, icon: '❔', svg: 'dots' };
  const isBesoin = a.type === 'besoin';
  const statutKey = a.statut || 'ouvert';
  const statut = STATUTS[statutKey] || STATUTS.ouvert;
  const off = statutKey !== 'ouvert';
  const stale = !off && (Date.now() - (a.createdAt || 0)) > CRISE.joursAVerifier * 864e5;
  const mine = getMineIds().has(a.id);
  const telClean = cleanTel(a.contactTel);
  const prenom = escapeHTML(a.contactPrenom);
  const distLabel = (userPos && hasCoords(a))
    ? ` · ${distanceKm(userPos.lat, userPos.lon, a.lat, a.lon).toFixed(1).replace('.', ',')} km`
    : '';

  const statutButtons = mine ? `
    <div class="ad__mine">
      <span class="ad__mine-k">Votre annonce :</span>
      ${Object.entries(STATUTS).map(([key, s]) =>
        `<button data-set-statut="${a.id}" data-statut-value="${key}" class="statut-btn" data-active="${statutKey === key}">${s.label}</button>`
      ).join('')}
    </div>` : '';

  // « Ouvert » est l'état normal : on ne l'affiche qu'en lecteur d'écran ; les autres états se voient.
  const statutBadge = off
    ? `<span class="ad__st statut-badge--${statutKey}">${statut.label}</span>`
    : `<span class="sr-only statut-badge--${statutKey}">${statut.label}</span>`;

  return `
  <article class="card-enter card-annonce ad ${isBesoin ? 'ad--need' : 'ad--give'} ${off ? 'ad--off card-annonce--inactive' : ''}">
    <div class="ad__top">
      <span class="ad__type">${isBesoin ? 'Besoin' : 'Offre'}</span>${a.demo ? '<span class="ad__demo">Exemple</span>' : ''}
      <span class="ad__cat">${ico(cat.svg)}${escapeHTML(cat.label)}</span>
      ${statutBadge}
      <span class="ad__when">${timeAgo(a.createdAt)}${distLabel}</span>
    </div>
    <p class="ad__desc">${escapeHTML(a.description)}</p>
    <p class="ad__where">${ico('pin')}<span><strong>${escapeHTML(lieuComplet(a))}</strong> · ${prenom}</span></p>
    ${stale ? `<p class="ad__stale">${ico('info')}<span>Publiée il y a plus de ${CRISE.joursAVerifier} jours : appelez pour vérifier qu'elle est toujours d'actualité.</span></p>` : ''}
    <div class="ad__acts">
      <a href="tel:${telClean}" class="ad__call">${ico('phone')}<span class="ad__callt">Appeler ${prenom}</span></a>
      ${a.demo
        ? `<button type="button" class="ad__share" data-demo-off>${ico('share')}<span>Partager</span></button>`
        : `<a href="${whatsappLink(a)}" target="_blank" rel="noopener" class="ad__share">${ico('share')}<span>Partager</span></a>`}
      <button data-copy="${escapeHTML(a.contactTel)}" class="btn-copy ad__icon" aria-label="Copier le numéro" title="Copier le numéro">${ico('copy')}</button>
      ${a.demo ? '' : `<a class="ad__icon ad__report" href="mailto:contact@evoshifting.com?subject=${encodeURIComponent('Signalement annonce ' + a.id)}" aria-label="Signaler cette annonce" title="Signaler cette annonce">${ico('flag')}</a>`}
      ${mine ? `<button data-delete="${a.id}" class="btn-delete ad__icon" aria-label="Supprimer mon annonce" title="Supprimer mon annonce">${ico('trash')}</button>` : ''}
    </div>
    ${statutButtons}
  </article>`;
}

/* =====================================================================
   RENDU DU FIL (recherche → facettes → tri → pagination)
===================================================================== */

// Une annonce trop ancienne n'est plus montrée : hors crise, un fil vide vaut mieux
// que des offres périmées. Son auteur la voit toujours, pour pouvoir la gérer.
function isRecent(a) {
  return getMineIds().has(a.id) || (Date.now() - (a.createdAt || 0)) <= CRISE.joursMax * 864e5;
}

function renderFeed() {
  const everything = readAll();
  const all = everything.filter(isRecent);
  const hiddenOld = everything.length - all.length;
  renderStats(all);

  const searchFiltered = all.filter(a => matchesSearch(a, searchQuery));
  renderFacets(all, searchFiltered);

  let result = filteredExcept(searchFiltered, null);
  if (hideResolved) result = result.filter(a => (a.statut || 'ouvert') === 'ouvert');

  if (sortOrder === 'distance' && userPos) {
    result = result.slice().sort((a, b) => {
      const da = hasCoords(a) ? distanceKm(userPos.lat, userPos.lon, a.lat, a.lon) : Infinity;
      const db_ = hasCoords(b) ? distanceKm(userPos.lat, userPos.lon, b.lat, b.lon) : Infinity;
      return da - db_;
    });
  } else {
    result = result.sort((a, b) => sortOrder === 'recent' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt);
  }

  renderMap(result);

  const totalPages = Math.max(1, Math.ceil(result.length / PAGE_SIZE));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);
  const pageItems = result.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  resultCount.textContent = result.length ? `${result.length} annonce${result.length > 1 ? 's' : ''}` : '';
  if (filtersResultCount) filtersResultCount.textContent = String(result.length);
  if (filtersResultPlural) filtersResultPlural.textContent = result.length > 1 ? 's' : '';

  if (viewMode === 'map') return; // le fil/pagination restent masqués, la carte a déjà été mise à jour ci-dessus

  if (result.length === 0) {
    feed.innerHTML = '';
    emptyState.classList.remove('hidden');
    const t = emptyState.querySelector('.empty__t'), sub = emptyState.querySelector('.empty__s');
    const filtering = searchQuery || filterType !== 'all' || filterCat !== 'all' || filterZone !== 'all' || hideResolved;
    if (t && sub) {
      if (!all.length && hiddenOld) {
        t.textContent = 'Aucune annonce récente';
        sub.textContent = `Les annonces de plus de ${CRISE.joursMax} jours sont masquées automatiquement. Besoin d'aide ou envie d'aider ? Publiez une annonce.`;
      } else if (!filtering && !all.length) {
        t.textContent = "Aucune annonce pour l'instant";
        sub.textContent = "Besoin d'aide ou envie d'aider ? Publiez la première annonce.";
      } else {
        t.textContent = 'Aucune annonce ne correspond';
        sub.textContent = 'Élargissez la recherche ou les filtres, ou publiez une annonce.';
      }
    }
    pagination.classList.add('hidden');
    return;
  }
  emptyState.classList.add('hidden');
  feed.innerHTML = pageItems.map(cardHTML).join('');

  if (totalPages > 1) {
    pagination.classList.remove('hidden');
    pagination.innerHTML = `
      <button id="page-prev" ${currentPage === 1 ? 'disabled' : ''}>Précédentes</button>
      <span>Page ${currentPage} sur ${totalPages}</span>
      <button id="page-next" ${currentPage === totalPages ? 'disabled' : ''}>Suivantes</button>`;
    el('page-prev')?.addEventListener('click', () => { currentPage--; renderFeed(); window.scrollTo({ top: feed.offsetTop - 90, behavior: 'smooth' }); });
    el('page-next')?.addEventListener('click', () => { currentPage++; renderFeed(); window.scrollTo({ top: feed.offsetTop - 90, behavior: 'smooth' }); });
  } else {
    pagination.classList.add('hidden');
  }
}

feed.addEventListener('click', async (e) => {
  if (e.target.closest('[data-demo-off]')) { showToast("Annonce d'exemple : le partage est désactivé en mode démo"); return; }
  const telLink = e.target.closest('a[href^="tel:"]');
  if (telLink) logEvent('appel_clique', {});
  const waLink = e.target.closest('a[href*="wa.me"]');
  if (waLink) logEvent('partage_clique', {});

  const copyBtn = e.target.closest('.btn-copy');
  if (copyBtn) {
    const tel = copyBtn.getAttribute('data-copy');
    try { await navigator.clipboard.writeText(tel); showToast('Numéro copié'); }
    catch { showToast(tel); }
    return;
  }
  const delBtn = e.target.closest('.btn-delete');
  if (delBtn) {
    const id = delBtn.getAttribute('data-delete');
    if (confirm('Supprimer cette annonce ?')) {
      deleteAnnonce(id);
      renderFeed();
      showToast('Annonce supprimée');
    }
    return;
  }
  const statutBtn = e.target.closest('[data-set-statut]');
  if (statutBtn) {
    const id = statutBtn.getAttribute('data-set-statut');
    const statut = statutBtn.getAttribute('data-statut-value');
    setStatut(id, statut);
    showToast(`Statut mis à jour : ${(STATUTS[statut] || {}).label || statut}`);
    return;
  }
});

/* =====================================================================
   RECHERCHE / TRI
===================================================================== */

let searchDebounce;
searchBox.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchQuery = searchBox.value.trim();
    currentPage = 1;
    renderFeed();
  }, 200);
});
sortSelect.addEventListener('change', () => {
  sortOrder = sortSelect.value;
  renderFeed();
});

/* =====================================================================
   VUE CARTE (Leaflet / OpenStreetMap, gratuit, sans clé)
===================================================================== */

// Centre + zoom couvrant toute la zone touchée par l'incendie (au nord de
// Lacanau, au sud de Biscarrosse, à l'ouest et au sud de Bordeaux) — pas
// seulement le Bassin d'Arcachon, pour ne pas paraître arbitrairement
// zoomé sur un seul secteur au chargement initial.
const DEFAULT_MAP_CENTER = [46.6, 2.4]; // France métropolitaine
const DEFAULT_MAP_ZOOM = 6;
let leafletLoadPromise = null;

function ensureLeafletLoaded() {
  if (typeof L !== 'undefined') return Promise.resolve();
  if (leafletLoadPromise) return leafletLoadPromise;
  leafletLoadPromise = Promise.all([
    loadStylesheetOnce('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'),
    loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'),
  ]).catch((err) => console.warn('[UEI] Impossible de charger la carte (Leaflet)', err));
  return leafletLoadPromise;
}

function renderMap(list) {
  if (typeof L === 'undefined') return; // pas encore chargé (ou CDN bloqué) : la vue carte reste simplement inactive
  if (!leafletMap) {
    leafletMap = L.map(mapContainer).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(leafletMap);
    leafletMarkersLayer = L.layerGroup().addTo(leafletMap);
  }
  leafletMarkersLayer.clearLayers();
  const withCoords = list.filter(hasCoords);
  withCoords.forEach(a => {
    const cat = CATEGORIES[a.categorie] || { label: a.categorie, icon: '❔' };
    const color = a.type === 'besoin' ? '#B93A0B' : '#1F6B45';
    const marker = L.circleMarker([a.lat, a.lon], {
      radius: 9, color: '#111827', weight: 1.5, fillColor: color, fillOpacity: 0.9,
    });
    marker.bindPopup(`
      <strong>${a.type === 'besoin' ? 'Besoin' : 'Offre'} · ${escapeHTML(cat.label)}</strong><br>
      ${escapeHTML(lieuComplet(a))}<br>
      ${escapeHTML(a.description)}<br>
      <a href="tel:${cleanTel(a.contactTel)}">📞 ${escapeHTML(a.contactTel)}</a>
    `);
    marker.addTo(leafletMarkersLayer);
  });
  if (withCoords.length === 1) {
    // Un seul point : fitBounds sur un point unique zoomerait au maximum
    // (zone quasi nulle), donnant l'impression très rapprochée observée.
    // On centre plutôt avec un zoom raisonnable, cohérent avec l'échelle
    // régionale de la zone d'incendie.
    leafletMap.setView([withCoords[0].lat, withCoords[0].lon], 12);
  } else if (withCoords.length > 1) {
    leafletMap.fitBounds(withCoords.map(a => [a.lat, a.lon]), { padding: [40, 40], maxZoom: 12 });
  } else {
    leafletMap.setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
  }
}

function setViewMode(mode) {
  viewMode = mode;
  btnViewFeed.setAttribute('data-active', mode === 'feed');
  btnViewMap.setAttribute('data-active', mode === 'map');
  if (mode === 'map') {
    feed.classList.add('hidden');
    emptyState.classList.add('hidden');
    pagination.classList.add('hidden');
    mapView.classList.remove('hidden');
    ensureLeafletLoaded().then(() => {
      setTimeout(() => leafletMap?.invalidateSize(), 50); // la carte a besoin d'un conteneur visible pour se dimensionner correctement
      renderFeed(); // redessine la carte une fois Leaflet chargé
    });
  } else {
    mapView.classList.add('hidden');
    feed.classList.remove('hidden');
  }
  renderFeed();
}
btnViewFeed.addEventListener('click', () => setViewMode('feed'));
btnViewMap.addEventListener('click', () => setViewMode('map'));

/* =====================================================================
   GÉOLOCALISATION « AUTOUR DE MOI »
===================================================================== */

/* =====================================================================
   GÉOLOCALISATION « AUTOUR DE MOI » (bouton dupliqué : barre desktop +
   tiroir mobile — les deux déclenchent exactement le même comportement)
===================================================================== */

function triggerGeoloc(sourceBtn) {
  if (!('geolocation' in navigator)) {
    showToast("Géolocalisation non disponible sur cet appareil");
    return;
  }
  const allGeolocBtns = [btnGeoloc, btnGeolocMobile].filter(Boolean);
  allGeolocBtns.forEach(b => b.innerHTML = `${ico('locate')}Localisation…`);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      allGeolocBtns.forEach(b => { b.innerHTML = `${ico('locate')}Autour de moi`; b.setAttribute('data-active', 'true'); });
      const distOption = sortSelect.querySelector('option[value="distance"]');
      if (distOption) distOption.disabled = false;
      sortSelect.value = 'distance';
      sortOrder = 'distance';
      showToast('Position obtenue — tri par distance activé');
      renderFeed();
    },
    (err) => {
      allGeolocBtns.forEach(b => b.innerHTML = `${ico('locate')}Autour de moi`);
      showToast("Localisation refusée ou indisponible");
      console.warn('[UEI] Géolocalisation refusée/indisponible', err);
    },
    { enableHighAccuracy: false, timeout: 8000 }
  );
}
btnGeoloc.addEventListener('click', () => triggerGeoloc(btnGeoloc));
if (btnGeolocMobile) btnGeolocMobile.addEventListener('click', () => triggerGeoloc(btnGeolocMobile));

/* =====================================================================
   MASQUER LES ANNONCES POURVUES / EN PAUSE (case à cocher dupliquée :
   barre desktop + tiroir mobile, toujours synchronisées entre elles)
===================================================================== */

function setHideResolved(val) {
  hideResolved = val;
  chkHideResolved.checked = val;
  if (chkHideResolvedMobile) chkHideResolvedMobile.checked = val;
  currentPage = 1;
  renderFeed();
}
chkHideResolved.addEventListener('change', () => setHideResolved(chkHideResolved.checked));
if (chkHideResolvedMobile) chkHideResolvedMobile.addEventListener('change', () => setHideResolved(chkHideResolvedMobile.checked));

/* =====================================================================
   PANNEAU DE FILTRES PARTAGÉ — dropdown ancré sur desktop (Catégorie OU
   Zone, un seul à la fois), tiroir du bas sur mobile (Catégorie ET Zone
   ensemble). Un seul jeu de facet-cat/facet-zone dans le DOM (voir HTML),
   la même liste sert donc dans les deux présentations sans dupliquer la
   logique de filtrage.
===================================================================== */

function isDesktopFilters() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1024px)').matches;
}

let filtersPanelOpen = false;

function openFiltersPanel(mode, anchorBtn) {
  filtersPanel.classList.remove('hidden');
  if (zoneSearchBox && (mode === 'zone' || mode === 'both')) {
    zoneSearchBox.value = '';
    facetZone.querySelectorAll('[data-filter-zone]').forEach(btn => btn.classList.remove('hidden'));
  }
  if (isDesktopFilters()) {
    // Desktop : un seul des deux blocs visible à la fois, ancré sous le bouton cliqué
    filtersSectionCat.classList.toggle('hidden', mode !== 'cat');
    filtersSectionZone.classList.toggle('hidden', mode !== 'zone');
    if (anchorBtn) {
      filtersPanel.style.left = anchorBtn.offsetLeft + 'px';
    }
    btnToggleCat.setAttribute('aria-expanded', String(mode === 'cat'));
    btnToggleZone.setAttribute('aria-expanded', String(mode === 'zone'));
    btnToggleCat.setAttribute('data-active', String(mode === 'cat'));
    btnToggleZone.setAttribute('data-active', String(mode === 'zone'));
  } else {
    // Mobile : les deux sections toujours ensemble dans le tiroir
    filtersSectionCat.classList.remove('hidden');
    filtersSectionZone.classList.remove('hidden');
    filtersOverlay.classList.remove('hidden');
    btnOpenFilters.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }
  filtersPanelOpen = true;
}

function closeFiltersPanel() {
  filtersPanel.classList.add('hidden');
  filtersOverlay.classList.add('hidden');
  btnToggleCat.setAttribute('aria-expanded', 'false');
  btnToggleZone.setAttribute('aria-expanded', 'false');
  btnToggleCat.setAttribute('data-active', 'false');
  btnToggleZone.setAttribute('data-active', 'false');
  btnOpenFilters.setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
  filtersPanelOpen = false;
}

btnToggleCat.addEventListener('click', () => {
  if (filtersPanelOpen && filtersPanel.getAttribute('data-mode') === 'cat') { closeFiltersPanel(); return; }
  filtersPanel.setAttribute('data-mode', 'cat');
  openFiltersPanel('cat', btnToggleCat);
});
btnToggleZone.addEventListener('click', () => {
  if (filtersPanelOpen && filtersPanel.getAttribute('data-mode') === 'zone') { closeFiltersPanel(); return; }
  filtersPanel.setAttribute('data-mode', 'zone');
  openFiltersPanel('zone', btnToggleZone);
});
btnOpenFilters.addEventListener('click', () => {
  if (filtersPanelOpen) { closeFiltersPanel(); return; }
  filtersPanel.setAttribute('data-mode', 'both');
  openFiltersPanel('both', btnOpenFilters);
});
btnCloseFiltersDesktop.addEventListener('click', closeFiltersPanel);
btnApplyFilters.addEventListener('click', closeFiltersPanel);
filtersOverlay.addEventListener('click', closeFiltersPanel);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && filtersPanelOpen) closeFiltersPanel();
});
document.addEventListener('click', (e) => {
  // Fermeture au clic extérieur, desktop uniquement (le tiroir mobile a son overlay dédié)
  if (!filtersPanelOpen || !isDesktopFilters()) return;
  if (filtersPanel.contains(e.target) || btnToggleCat.contains(e.target) || btnToggleZone.contains(e.target)) return;
  closeFiltersPanel();
});

btnResetFilters.addEventListener('click', () => {
  filterCat = 'all';
  filterZone = 'all';
  setHideResolved(false);
  currentPage = 1;
  renderFeed();
});

// Recherche en direct dans la liste des zones (utile dès que la liste
// s'allonge — voir le seuil d'affichage du champ dans renderFacets)
if (zoneSearchBox) {
  zoneSearchBox.addEventListener('input', () => {
    const q = normalizeText(zoneSearchBox.value.trim());
    facetZone.querySelectorAll('[data-filter-zone]').forEach(btn => {
      if (btn.getAttribute('data-filter-zone') === 'all') return; // "Toutes zones" toujours visible
      const label = btn.getAttribute('data-zone-label') || '';
      btn.classList.toggle('hidden', q.length > 0 && !label.includes(q));
    });
  });
}

/* =====================================================================
   CARTE "INFO OFFICIELLE" REPLIABLE — ouverte par défaut sur desktop,
   repliée par défaut sur mobile (une seule ligne, moins envahissant)
===================================================================== */

if (infoCard && infoToggle) {
  infoCard.setAttribute('data-open', isDesktopFilters() ? 'true' : 'false');
  infoToggle.setAttribute('aria-expanded', isDesktopFilters() ? 'true' : 'false');
  infoToggle.addEventListener('click', () => {
    const nowOpen = infoCard.getAttribute('data-open') !== 'true';
    infoCard.setAttribute('data-open', String(nowOpen));
    infoToggle.setAttribute('aria-expanded', String(nowOpen));
  });
}

/* =====================================================================
   AUTOCOMPLÉTION D'ADRESSE (API Adresse — Base Adresse Nationale,
   data.gouv.fr : gratuite, publique, sans clé). Dégrade proprement en
   saisie libre si hors-ligne ou si l'API ne répond pas.
===================================================================== */

const communeInput = el('f-commune-input');
const communeHidden = el('f-commune');
const communeLat = el('f-lat');
const communeLon = el('f-lon');
const communeSuggestions = el('f-commune-suggestions');
let communeDebounce, communeAbort;

function hideCommuneSuggestions() {
  communeSuggestions.classList.add('hidden');
  communeSuggestions.innerHTML = '';
}

async function fetchCommuneSuggestions(q) {
  communeAbort?.abort();
  communeAbort = new AbortController();
  try {
    // On utilise l'API Découpage administratif (geo.api.gouv.fr), pas l'API
    // Adresse (api-adresse.data.gouv.fr) : cette dernière ne renvoie qu'UN
    // SEUL code postal par ville, même pour les villes qui en ont plusieurs
    // (Bordeaux, Toulouse, Nantes, Lille...) — limite documentée de cette
    // API, confirmée par le forum officiel Etalab. geo.api.gouv.fr renvoie
    // en revanche la liste complète des codes postaux par commune
    // (`codesPostaux`), ce qui permet de proposer "Bordeaux 33000",
    // "Bordeaux 33100", "Bordeaux 33300"... séparément, comme sur les
    // sites d'annonces grand public.
    // `boost=population` fait remonter les grandes villes en premier
    // (évite qu'un hameau homonyme perdu dans un autre département sorte
    // avant la vraie ville recherchée).
    const res = await fetch(`https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(q)}&boost=population&limit=6&fields=nom,codesPostaux,centre`, { signal: communeAbort.signal });
    if (!res.ok) throw new Error('bad response');
    const communes = await res.json();
    if (!Array.isArray(communes) || !communes.length) { hideCommuneSuggestions(); return; }
    // Développe chaque commune en une ligne par code postal.
    const rows = [];
    communes.forEach(c => {
      const [lon, lat] = c.centre?.coordinates || [];
      const postcodes = (c.codesPostaux && c.codesPostaux.length) ? c.codesPostaux : [''];
      postcodes.forEach(cp => rows.push({ nom: c.nom, postcode: cp, lat, lon }));
    });
    const limited = rows.slice(0, 14);
    communeSuggestions.innerHTML = limited.map(r => {
      const value = r.postcode ? `${r.nom} ${r.postcode}` : r.nom;
      return `<li data-value="${escapeHTML(value)}" data-lat="${r.lat ?? ''}" data-lon="${r.lon ?? ''}" class="px-3 py-2.5 hover:bg-warm-100 cursor-pointer text-sm border-b border-sand/30 last:border-0 flex items-center justify-between gap-2">
        <span>${escapeHTML(r.nom)}</span><span class="font-semibold text-xs text-gray-500 shrink-0">${escapeHTML(r.postcode)}</span>
      </li>`;
    }).join('');
    communeSuggestions.classList.remove('hidden');
  } catch (err) {
    if (err.name !== 'AbortError') hideCommuneSuggestions(); // API indisponible : on laisse la saisie libre faire foi
  }
}

communeInput.addEventListener('input', () => {
  communeHidden.value = '';
  communeLat.value = '';
  communeLon.value = '';
  const q = communeInput.value.trim();
  clearTimeout(communeDebounce);
  if (q.length < 2) { hideCommuneSuggestions(); return; }
  communeDebounce = setTimeout(() => fetchCommuneSuggestions(q), 250);
});
communeSuggestions.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-value]');
  if (!li) return;
  const value = li.getAttribute('data-value');
  communeInput.value = value;
  communeHidden.value = value;
  communeLat.value = li.getAttribute('data-lat') || '';
  communeLon.value = li.getAttribute('data-lon') || '';
  hideCommuneSuggestions();
});
communeInput.addEventListener('blur', () => {
  setTimeout(() => {
    hideCommuneSuggestions();
    if (!communeHidden.value) communeHidden.value = communeInput.value.trim(); // repli : saisie libre acceptée
  }, 150);
});
document.addEventListener('click', (e) => {
  if (!communeInput.contains(e.target) && !communeSuggestions.contains(e.target)) hideCommuneSuggestions();
});

/* =====================================================================
   AUTOCOMPLÉTION DU QUARTIER — API Adresse (api-adresse.data.gouv.fr),
   contrairement au champ Ville : ici on VEUT la précision rue/quartier
   que cette API donne bien (elle n'est mauvaise que pour les recherches
   de simples noms de ville, à cause de son classement par pertinence
   textuelle plutôt que par importance — pas un souci quand on tape déjà
   un nom de quartier précis). La recherche est biaisée autour de la
   ville déjà choisie (paramètres lat/lon) pour prioriser les résultats
   proches plutôt qu'un homonyme à l'autre bout de la France.
   Sélectionner une suggestion ici AFFINE les coordonnées GPS de
   l'annonce (elles remplacent celles, plus approximatives, de la ville
   seule) — la carte devient donc plus précise, sans rien casser côté
   filtre "Zone" qui continue de se baser sur le champ Ville.
===================================================================== */

const quartierInput = el('f-quartier');
const quartierSuggestions = el('f-quartier-suggestions');
let quartierDebounce, quartierAbort;

function hideQuartierSuggestions() {
  quartierSuggestions.classList.add('hidden');
  quartierSuggestions.innerHTML = '';
}

async function fetchQuartierSuggestions(q) {
  quartierAbort?.abort();
  quartierAbort = new AbortController();
  try {
    let url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=6`;
    if (communeLat.value && communeLon.value) {
      url += `&lat=${encodeURIComponent(communeLat.value)}&lon=${encodeURIComponent(communeLon.value)}`;
    }
    const res = await fetch(url, { signal: quartierAbort.signal });
    if (!res.ok) throw new Error('bad response');
    const data = await res.json();
    const features = data.features || [];
    if (!features.length) { hideQuartierSuggestions(); return; }
    quartierSuggestions.innerHTML = features.map(f => {
      const label = f.properties.label;
      const [lon, lat] = f.geometry?.coordinates || [];
      return `<li data-value="${escapeHTML(f.properties.name || label)}" data-lat="${lat ?? ''}" data-lon="${lon ?? ''}" class="px-3 py-2.5 hover:bg-warm-100 cursor-pointer text-sm border-b border-sand/30 last:border-0">
        ${escapeHTML(label)}
      </li>`;
    }).join('');
    quartierSuggestions.classList.remove('hidden');
  } catch (err) {
    if (err.name !== 'AbortError') hideQuartierSuggestions(); // API indisponible : le champ reste un simple texte libre
  }
}

quartierInput.addEventListener('input', () => {
  const q = quartierInput.value.trim();
  clearTimeout(quartierDebounce);
  if (q.length < 3) { hideQuartierSuggestions(); return; }
  quartierDebounce = setTimeout(() => fetchQuartierSuggestions(q), 250);
});
quartierSuggestions.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-value]');
  if (!li) return;
  quartierInput.value = li.getAttribute('data-value');
  const lat = li.getAttribute('data-lat');
  const lon = li.getAttribute('data-lon');
  // On affine les coordonnées de l'annonce SEULEMENT si la suggestion en
  // fournit — sinon on garde celles, plus larges, de la ville.
  if (lat && lon) { communeLat.value = lat; communeLon.value = lon; }
  hideQuartierSuggestions();
});
quartierInput.addEventListener('blur', () => setTimeout(hideQuartierSuggestions, 150));
document.addEventListener('click', (e) => {
  if (!quartierInput.contains(e.target) && !quartierSuggestions.contains(e.target)) hideQuartierSuggestions();
});

/* =====================================================================
   MODALE / PUBLICATION
===================================================================== */

function openModal(presetType) {
  annonceForm.reset();
  communeHidden.value = '';
  communeLat.value = '';
  communeLon.value = '';
  hideCommuneSuggestions();
  hideQuartierSuggestions();
  descriptionCharCount.textContent = '0';
  const identity = getIdentity();
  if (identity) {
    el('f-prenom').value = identity.prenom;
    el('f-tel').value = identity.tel;
  }
  if (presetType) {
    const radio = annonceForm.querySelector(`input[name="type"][value="${presetType}"]`);
    if (radio) radio.checked = true;
    modalTitle.textContent = presetType === 'besoin' ? "Je cherche de l'aide" : "Je propose de l'aide";
  } else {
    modalTitle.textContent = 'Publier une annonce';
  }
  formError.classList.add('hidden');
  updateDescriptionPlaceholder();
  lastModalTrigger = document.activeElement;
  modalBackdrop.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(() => el('f-categorie').focus(), 30);
}
let lastModalTrigger = null;
function updateDescriptionPlaceholder() {
  const type = annonceForm.querySelector('input[name="type"]:checked')?.value;
  el('f-description').placeholder = type === 'besoin'
    ? 'Ex : Famille de 4 évacuée, cherche un hébergement pour 2 nuits, avec un chien calme.'
    : 'Ex : Chambre disponible pour 2 personnes, arrivée possible ce soir, parking.';
}
annonceForm.querySelectorAll('input[name="type"]').forEach(r => r.addEventListener('change', updateDescriptionPlaceholder));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = id => !document.getElementById(id)?.classList.contains('hidden');
  if (open('modal-backdrop')) closeModal();
  else if (open('soutien-modal-backdrop')) closeSoutienModal();
  else if (open('manage-modal-backdrop')) closeManageModal();
  else if (open('share-modal-backdrop')) closeShareModal();
});
function closeModal() {
  modalBackdrop.classList.add('hidden');
  document.body.style.overflow = '';
  if (lastModalTrigger && document.contains(lastModalTrigger)) lastModalTrigger.focus();
}
btnDemander.addEventListener('click', () => openModal('besoin'));
btnProposer.addEventListener('click', () => openModal('offre'));
btnCloseModal.addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', (e) => { if (e.target === modalBackdrop) closeModal(); });

function validatePhone(raw) {
  const cleaned = (raw || '').trim().replace(/[\s.\-()]/g, '');
  if (/^\+33[1-9]\d{8}$/.test(cleaned)) return true; // +33 suivi de 9 chiffres (sans le 0 initial) = 10 chiffres au total
  const digitsOnly = cleaned.replace(/^\+/, '').replace(/\D/g, '');
  // Exactement 10 chiffres (format français standard 0X XX XX XX XX) —
  // pas "au moins 10" : un numéro à 11 chiffres ou plus est bien invalide,
  // pas juste "un peu long".
  return digitsOnly.length === 10;
}

const telInput = el('f-tel');
const telError = el('f-tel-error');
telInput.addEventListener('input', () => telError.classList.add('hidden'));

const descriptionInput = el('f-description');
const descriptionCharCount = el('description-char-count');
descriptionInput.addEventListener('input', () => {
  descriptionCharCount.textContent = String(descriptionInput.value.length);
});

annonceForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (demoMode) {
    formError.textContent = "Mode démo : rien n'est publié. Quittez la démo pour publier une vraie annonce.";
    formError.classList.remove('hidden');
    return;
  }
  const type = annonceForm.querySelector('input[name="type"]:checked')?.value;
  const categorie = el('f-categorie').value;
  const commune = communeHidden.value || communeInput.value.trim();
  const quartier = el('f-quartier').value.trim();
  const description = el('f-description').value.trim();
  const contactPrenom = el('f-prenom').value.trim();
  const contactTel = el('f-tel').value.trim();
  const lat = communeLat.value ? parseFloat(communeLat.value) : null;
  const lon = communeLon.value ? parseFloat(communeLon.value) : null;

  if (!type || !categorie || !commune || !description || !contactPrenom || !contactTel) {
    formError.textContent = 'Merci de remplir tous les champs obligatoires.';
    formError.classList.remove('hidden');
    return;
  }

  if (!validatePhone(contactTel)) {
    telError.classList.remove('hidden');
    telInput.focus();
    return;
  }
  telError.classList.add('hidden');

  setIdentity(contactPrenom, contactTel);
  const annonce = addAnnonce({ type, categorie, commune, quartier, description, contactPrenom, contactTel, lat, lon });
  markMine(annonce.id);
  closeModal();
  currentPage = 1;
  renderFeed();
  replayLogoAnimation(headerLogoSvg);
  openConfirmationOverlay(() => openShareModal(annonce));
});

/* =====================================================================
   ANIMATION DE VALIDATION — logo "braise vivante" + confirmation plein
   écran chaleureuse, jouée à chaque publication d'annonce réussie
   (demande ou offre). Jamais en boucle au repos, jamais anxiogène.
===================================================================== */

const headerLogoSvg = el('header-logo-svg');

// Rejoue l'animation CSS d'un SVG en repartant de zéro (retire la classe,
// force un reflow, la remet) — sans ce forçage, réappliquer la même
// classe ne redéclenche rien si elle était déjà présente.
function replayLogoAnimation(svgEl) {
  if (!svgEl) return;
  svgEl.classList.remove('uei-anim');
  void svgEl.getBoundingClientRect(); // force le reflow
  svgEl.classList.add('uei-anim');
}

// Même structure que le logo du header, avec des identifiants de
// dégradé/filtre distincts (des ids dupliqués entre deux <svg> présents
// simultanément dans le DOM casseraient le rendu de l'un des deux).
function overlayLogoSvgMarkup() {
  return `<svg id="overlay-logo-svg" width="88" height="88" viewBox="0 0 64 64" style="overflow:visible" class="mx-auto mb-4" aria-hidden="true">
    <defs>
      <linearGradient id="uei-tile-ovl" x1="10" y1="6" x2="54" y2="60" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#FF9D5C"/><stop offset=".52" stop-color="#F26D2B"/><stop offset="1" stop-color="#E14B10"/>
      </linearGradient>
      <linearGradient id="uei-sheen-ovl" x1="32" y1="4" x2="32" y2="34" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#fff" stop-opacity=".30"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
      </linearGradient>
      <filter id="uei-shadow-ovl" x="-30%" y="-25%" width="160%" height="165%">
        <feDropShadow dx="0" dy="2.5" stdDeviation="3.5" flood-color="#C63E08" flood-opacity=".26"/>
      </filter>
    </defs>
    <g filter="url(#uei-shadow-ovl)">
      <path fill="url(#uei-tile-ovl)" d="M22 4h20c8.5 0 12.8 0 15.4 2.6C60 9.2 60 13.5 60 22v20c0 8.5 0 12.8-2.6 15.4C54.8 60 50.5 60 42 60H22c-8.5 0-12.8 0-15.4-2.6C4 54.8 4 50.5 4 42V22c0-8.5 0-12.8 2.6-15.4C9.2 4 13.5 4 22 4Z"/>
      <path fill="url(#uei-sheen-ovl)" d="M22 4h20c8.5 0 12.8 0 15.4 2.6C60 9.2 60 13.5 60 22v6H4v-6c0-8.5 0-12.8 2.6-15.4C9.2 4 13.5 4 22 4Z"/>
    </g>
    <g transform="translate(8 12) scale(2)" style="overflow:visible">
      <circle class="uei-glow" cx="12" cy="12" r="10" fill="none" stroke="#FDBA74" stroke-width="1.4"/>
      <g class="uei-flame">
        <path fill="#fff" fill-rule="evenodd" clip-rule="evenodd" d="M12 2.3c3.4 3.5 5.6 6.6 5.6 10.4a5.6 5.6 0 0 1-11.2 0c0-1.6.5-3 1-4 .6 1.2 1.4 1.8 2.4 1.9-1.5-3.3.4-6.5 2.2-8.3Zm0 14.6c-2-1.5-3.4-2.8-3.4-4.4a1.75 1.75 0 0 1 3.4-.5 1.75 1.75 0 0 1 3.4.5c0 1.6-1.4 2.9-3.4 4.4Z"/>
      </g>
      <circle class="uei-ember e1" cx="10.5" cy="20" r=".7" fill="#FFD9A8"/>
      <circle class="uei-ember e2" cx="13.5" cy="20" r=".5" fill="#FFD9A8"/>
      <circle class="uei-ember e3" cx="12" cy="20" r=".6" fill="#FFD9A8"/>
    </g>
  </svg>`;
}

let confirmationOverlayEl = null;
let confirmationTimer = null;

// Confirmation chaleureuse plein écran : s'auto-ferme après ~2,2s ou au
// clic, jamais empilée (une nouvelle validation remplace la précédente
// et réinitialise le minuteur). onClose() s'exécute une seule fois,
// qu'elle que soit la façon dont l'overlay se ferme.
function openConfirmationOverlay(onClose) {
  closeConfirmationOverlay(); // jamais deux overlays en même temps

  const overlay = document.createElement('div');
  overlay.className = 'uei-overlay';
  overlay.setAttribute('role', 'presentation');
  overlay.innerHTML = `
    <div class="uei-card" role="status" aria-live="polite">
      ${overlayLogoSvgMarkup()}
      <div style="font-size:20px;font-weight:800;color:#111827;">Annonce publiée !</div>
      <p style="margin-top:8px;font-size:15px;color:#6B7280;line-height:1.5;">Merci pour votre entraide. Votre annonce est maintenant visible par la communauté.</p>
    </div>`;
  document.body.appendChild(overlay);
  confirmationOverlayEl = overlay;

  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    closeConfirmationOverlay();
    if (onClose) onClose();
  };

  overlay.addEventListener('click', finish);
  confirmationTimer = setTimeout(finish, 2200);

  // Rejoue l'animation du logo à l'intérieur de l'overlay dès qu'il est
  // dans le DOM (double rAF : laisse le navigateur peindre l'état initial
  // avant d'ajouter la classe, sinon l'animation "saute" son départ).
  requestAnimationFrame(() => requestAnimationFrame(() => {
    replayLogoAnimation(el('overlay-logo-svg'));
  }));
}

function closeConfirmationOverlay() {
  clearTimeout(confirmationTimer);
  if (confirmationOverlayEl) {
    confirmationOverlayEl.remove();
    confirmationOverlayEl = null;
  }
}

/* =====================================================================
   MODALE DE PARTAGE APRÈS PUBLICATION
===================================================================== */

function openShareModal(annonce) {
  pendingShareData = annonce;
  btnShareWhatsappNow.href = whatsappLink(annonce);
  shareModalBackdrop.classList.remove('hidden');
}
function closeShareModal() {
  shareModalBackdrop.classList.add('hidden');
  pendingShareData = null;
}
btnCloseShareModal.addEventListener('click', closeShareModal);
shareModalBackdrop.addEventListener('click', (e) => { if (e.target === shareModalBackdrop) closeShareModal(); });
btnShareWhatsappNow.addEventListener('click', () => {
  showToast('Ouverture de WhatsApp…');
  setTimeout(closeShareModal, 400);
});

/* =====================================================================
   LIEN DE PARTAGE : encode l'annonce dans l'URL pour import automatique
===================================================================== */

function buildShareLink(a) {
  const base = location.origin + location.pathname;
  // Si Firestore est connecté (cas normal aujourd'hui que la synchronisation
  // est fiable), l'annonce est déjà visible pour quiconque ouvre le site —
  // pas besoin d'un lien à rallonge qui a l'air suspect dans WhatsApp.
  // On ne revient à l'ancien mécanisme (données encodées dans l'URL) que
  // si Firestore est indisponible : c'est alors le SEUL moyen pour
  // l'annonce de circuler malgré tout.
  if (!db) {
    const payload = {
      id: a.id, type: a.type, categorie: a.categorie, commune: a.commune,
      quartier: a.quartier || '', description: a.description,
      contactPrenom: a.contactPrenom, contactTel: a.contactTel, createdAt: a.createdAt,
      statut: a.statut || 'ouvert', lat: a.lat ?? null, lon: a.lon ?? null,
    };
    const encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(payload)))));
    return `${base}?a=${encoded}`;
  }
  return base;
}

function tryImportFromURL() {
  if (demoMode) return; // jamais d'import réel pendant la démo
  const params = new URLSearchParams(location.search);
  const raw = params.get('a');
  if (!raw) return;
  try {
    const json = decodeURIComponent(escape(atob(decodeURIComponent(raw))));
    const payload = JSON.parse(json);
    // ⚠️ Même garde-fou que pour la migration ascendante (voir pollFirestore,
    // bug corrigé le 27/07) : un vieux lien de partage (WhatsApp, historique
    // du navigateur, favori...) contient les données de l'annonce telles
    // qu'au moment du partage. Sans restriction, le rouvrir des jours après
    // réinjecterait l'annonce même si elle a été supprimée entre-temps par
    // un modérateur. On n'importe donc que les liens partagés récemment.
    const isRecent = payload && payload.createdAt && (Date.now() - payload.createdAt) < MIGRATION_WINDOW_MS;
    if (payload && payload.id && payload.type && payload.description && isRecent) {
      const added = importAnnonce(payload);
      if (added) {
        importBanner.classList.remove('hidden');
        setTimeout(() => importBanner.classList.add('hidden'), 6000);
      }
    } else if (payload && payload.id && !isRecent) {
      console.info('[UEI] Lien de partage trop ancien (>30 min), ignoré pour éviter de réinjecter une annonce potentiellement supprimée depuis.');
    }
  } catch (err) {
    console.warn('Lien de partage invalide', err);
  } finally {
    const url = new URL(location.href);
    url.searchParams.delete('a');
    history.replaceState({}, '', url.pathname + url.search);
  }
}

/* =====================================================================
   MUR DE SOUTIEN — bandeau de remerciement aux forces engagées (ordre
   mélangé une fois par chargement) + mur de messages libres des
   visiteurs, avec likes. Messages stockés dans une collection Firestore
   séparée ("soutien"). Même stratégie de sondage périodique que pour les
   annonces (la seule méthode dont on a la preuve qu'elle fonctionne dans
   cet environnement).
===================================================================== */

const FORCES = {
  "Sapeurs-pompiers & secours au sol": [
    'Sapeurs-pompiers (SDIS)', 'Colonnes de renfort inter-départementales',
    'Sapeurs-pompiers volontaires', 'SAMU / SMUR', 'Protection civile', 'Croix-Rouge française',
  ],
  "Soignants & professionnels de santé": [
    'Hôpitaux & CHU', 'Cliniques', 'Infirmiers & infirmières', 'Aides-soignants', 'Ambulanciers',
    'EHPAD & personnels', 'Médecins & urgentistes', 'Paramédicaux', 'Pharmaciens',
    'Psychologues & cellules de soutien',
  ],
  "Moyens aériens": [
    'Canadair', 'Dash 8', 'Hélicoptères bombardiers d\'eau', 'Pilotes de la Sécurité civile',
    'Avions de reconnaissance',
  ],
  "Forces de l'État & militaires": [
    'Sécurité civile', 'UIISC (ForMiSC)', 'Gendarmerie nationale', 'Police nationale & municipale',
    'Préfectures', 'Armée & réservistes',
  ],
  "Forêt, réseaux & environnement": [
    'Office national des forêts (ONF)', 'Services techniques des communes', 'ENEDIS & techniciens réseaux',
    'Agriculteurs (citernes, tracteurs)', 'Vétérinaires & secours animaliers',
  ],
  "Solidarité citoyenne": [
    'Bénévoles & réserves communales', 'Associations agréées de sécurité civile',
    'Communes & mairies', 'Restaurateurs & commerçants', 'Donateurs & don du sang (EFS)',
    'Hébergeurs solidaires',
  ],
};

const AVATAR_COLORS = [
  { bg: '#FDEFE6', fg: '#94300A' }, { bg: '#E8F3EC', fg: '#175536' },
  { bg: '#EEF2FF', fg: '#3730A3' }, { bg: '#FEF2F2', fg: '#991B1B' },
];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Mélange une seule fois par chargement de page (pas à chaque render) :
// aucun organisme ne doit sembler "en tête" ou prioritaire par rapport
// aux autres. Les catégories ne servent que de source : à l'affichage,
// tout est aplati en un seul rang mélangé (bandeau défilant compact).
const SHUFFLED_FORCES = shuffle(Object.values(FORCES).flat());

function renderForcesBanner() {
  const pills = SHUFFLED_FORCES.map(name => `<span class="forces__pill">${escapeHTML(name)}</span>`).join('');
  // Dupliqué deux fois : l'animation translate à -50% boucle ainsi sans
  // saut visible. Le 2ᵉ jeu est décoratif (même contenu), masqué aux
  // lecteurs d'écran.
  el('forces-track').innerHTML = pills + `<span aria-hidden="true" style="display:inline-flex;gap:8px;">${pills}</span>`;
}

/* =====================================================================
   BANDEAU DÉFILANT (TICKER) — trois sources mélangées : remerciements
   fixes, messages de soutien des visiteurs, actualités RSS France Info.

   ⚠️ Le flux RSS (franceinfo) est cross-origin : un fetch direct depuis
   le navigateur est bloqué par CORS, et ce site est 100% statique (pas
   de serveur). RSS_ENDPOINT pointe donc vers une route qui n'existe pas
   encore ("/api/rss-incendies") — tant qu'aucune fonction serveur n'est
   déployée (Cloudflare Worker, fonction Netlify/Vercel...), fetchInfoItems()
   échoue et se dégrade proprement : le ticker tourne quand même, juste
   sans les puces 🔴 INFO. C'est le comportement prévu, pas un bug.
===================================================================== */

const RSS_ENDPOINT = '/api/rss-incendies';

const TICKER_THANKS = [
  'Merci aux pompiers venus en renfort de toute la France 🧡',
  'Courage aux familles évacuées, on pense à vous',
  'Bravo aux bénévoles mobilisés au parc des expositions',
  'Merci aux soignants qui veillent sur les plus fragiles',
  'Merci à ceux qui ouvrent leur porte à des inconnus',
];

async function fetchInfoItems(limit = 6) {
  try {
    const res = await fetch(RSS_ENDPOINT, { cache: 'no-store' });
    if (!res.ok) throw new Error('endpoint indisponible');
    const xmlText = await res.text();
    const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('RSS invalide');
    return [...xml.querySelectorAll('item')]
      .slice(0, limit)
      .map(item => (item.querySelector('title')?.textContent || '').trim())
      .filter(Boolean)
      .map(title => ({ kind: 'info', text: title }));
  } catch (e) {
    // Dégradation gracieuse voulue : pas d'endpoint serveur disponible
    // pour l'instant sur ce site statique. Le ticker continue sans INFO.
    return [];
  }
}

function tickerChipHTML(it) {
  if (it.kind === 'info') {
    return `<span class="ticker-item"><span class="badge-info">🔴 INFO</span><span style="color:#F3F4F6;font-weight:500;">${escapeHTML(it.text)}</span></span>`;
  }
  if (it.kind === 'support') {
    return `<span class="ticker-item"><span style="color:#FDBA74;">💬</span><span style="color:#E5E7EB;">“${escapeHTML(it.text)}”</span><span style="color:#9CA3AF;font-weight:600;">— ${escapeHTML(it.name)}</span></span>`;
  }
  return `<span class="ticker-item"><span style="color:#FB923C;">🧡</span><span style="color:#E5E7EB;">${escapeHTML(it.text)}</span></span>`;
}

async function renderTicker() {
  if (!document.getElementById('ticker-track')) return;
  const track = el('ticker-track');
  const supportItems = soutienCache
    .filter(m => m.message)
    .map(m => ({ kind: 'support', text: m.message, name: m.pseudo || 'Anonyme' }));
  const items = [
    ...TICKER_THANKS.map(t => ({ kind: 'thanks', text: t })),
    ...supportItems,
    ...(await fetchInfoItems()),
  ];
  if (!items.length) return;
  const mixed = shuffle(items);
  const html = mixed.map(tickerChipHTML).join('');
  // Contenu dupliqué deux fois : l'animation translate à -50% boucle
  // ainsi sans saut visible.
  track.innerHTML = html + html;
}

const SOUTIEN_STORAGE_KEY = 'uei_soutien_v1';
const SOUTIEN_LIKES_KEY = 'uei_soutien_likes_v1'; // ids likés depuis CET appareil, anti double-like
let soutienCache = [];
let soutienMigrated = false;

function loadSoutienLocal() {
  try { return JSON.parse(localStorage.getItem(SOUTIEN_STORAGE_KEY)) || []; }
  catch { return []; }
}
function saveSoutienLocal(items) {
  try { localStorage.setItem(SOUTIEN_STORAGE_KEY, JSON.stringify(items)); } catch {}
}
function getLikedIds() {
  try { return new Set(JSON.parse(localStorage.getItem(SOUTIEN_LIKES_KEY)) || []); }
  catch { return new Set(); }
}
function saveLikedIds(set) {
  try { localStorage.setItem(SOUTIEN_LIKES_KEY, JSON.stringify([...set])); } catch {}
}

async function pollSoutien(isFirst) {
  if (!db) return;
  try {
    const snap = await db.collection('soutien').orderBy('createdAt', 'desc').limit(150).get();
    soutienCache = snap.docs.map(d => d.data());
    saveSoutienLocal(soutienCache);
    if (isFirst && !soutienMigrated) {
      soutienMigrated = true;
      const localBefore = loadSoutienLocal();
      const knownIds = new Set(soutienCache.map(m => m.id));
      // Même garde-fou que pour les annonces (voir pollFirestore) : ne
      // migrer que les messages très récents, jamais un vieux message en
      // cache qui pourrait avoir été supprimé intentionnellement depuis.
      const orphans = localBefore.filter(m => !knownIds.has(m.id) && (Date.now() - m.createdAt) < MIGRATION_WINDOW_MS);
      if (orphans.length) {
        soutienCache = [...orphans, ...soutienCache].sort((a, b) => b.createdAt - a.createdAt);
        saveSoutienLocal(soutienCache);
        orphans.forEach(m => db.collection('soutien').doc(m.id).set(m, { merge: true }).catch(() => {}));
      }
    }
    renderSoutienWall();
  } catch (err) {
    console.warn('[UEI] Échec sondage soutien', err);
  }
}

function addSoutienMessage(message, pseudo, lieu) {
  const m = { id: makeId(), message, pseudo: pseudo || null, lieu: lieu || null, likes: 0, createdAt: Date.now() };
  soutienCache = [m, ...soutienCache];
  saveSoutienLocal(soutienCache);
  renderSoutienWall();
  renderTicker();
  logEvent('soutien_publie', {});
  if (db) {
    db.collection('soutien').doc(m.id).set(m).catch((err) => {
      console.warn('[UEI] Échec envoi message de soutien, restera local seulement', err);
    });
  }
  return m;
}

function toggleLike(id) {
  const liked = getLikedIds();
  const isLiked = liked.has(id);
  const delta = isLiked ? -1 : 1;
  if (isLiked) liked.delete(id); else liked.add(id);
  saveLikedIds(liked);

  soutienCache = soutienCache.map(m => m.id === id ? { ...m, likes: Math.max(0, (m.likes || 0) + delta) } : m);
  saveSoutienLocal(soutienCache);
  renderSoutienWall();

  if (db) {
    // Nécessite que les règles Firestore autorisent la mise à jour du champ
    // "likes" (voir firebase-config.js). Incrément atomique côté serveur
    // pour rester correct même si plusieurs visiteurs likent en même temps.
    db.collection('soutien').doc(id).update({ likes: firebase.firestore.FieldValue.increment(delta) })
      .catch((err) => console.warn('[UEI] Échec synchronisation du like (règles Firestore à mettre à jour ?)', err));
  }
}

const SOUTIEN_APERCU = 6;
let soutienShowAll = false;
function renderSoutienWall() {
  el('soutien-count').textContent = soutienCache.length ? `${soutienCache.length} message${soutienCache.length > 1 ? 's' : ''}` : '';
  if (!soutienCache.length) {
    soutienWall.innerHTML = '';
    soutienEmpty.classList.remove('hidden');
    return;
  }
  soutienEmpty.classList.add('hidden');
  const liked = getLikedIds();
  const visibles = soutienShowAll ? soutienCache : soutienCache.slice(0, SOUTIEN_APERCU);
  const more = document.getElementById('soutien-more');
  if (more) {
    const reste = soutienCache.length - SOUTIEN_APERCU;
    more.classList.toggle('hidden', reste <= 0);
    more.textContent = soutienShowAll ? 'Afficher moins de messages' : `Voir les ${reste} autres messages`;
    more.onclick = () => { soutienShowAll = !soutienShowAll; renderSoutienWall(); };
  }
  soutienWall.innerHTML = visibles.map((m, i) => {
    const name = escapeHTML(m.pseudo || 'Anonyme');
    const initial = (m.pseudo || 'A').trim().charAt(0).toUpperCase();
    const color = AVATAR_COLORS[i % AVATAR_COLORS.length];
    const isLiked = liked.has(m.id);
    const likeCount = m.likes || 0;
    // Taille variable selon la longueur du message, pour un rythme organique
    // dans la grille maçonnée plutôt qu'une typographie uniforme et rigide.
    const fontSize = m.message.length > 80 ? '18px' : '16px';
    return `
    <article class="soutien-card">
      <p style="font-size:${fontSize};">${escapeHTML(m.message)}</p>
      <div class="soutien-footer">
        <div class="soutien-avatar" style="background:${color.bg};color:${color.fg};">${escapeHTML(initial)}</div>
        <div class="soutien-who">
          <div class="soutien-name">${name}</div>
          ${m.lieu ? `<div class="soutien-lieu">${escapeHTML(m.lieu)}</div>` : ''}
        </div>
        <button class="soutien-like" data-like="${escapeHTML(m.id)}" data-liked="${isLiked}" aria-pressed="${isLiked}" aria-label="Soutenir ce message (${likeCount})">${ico('heart')} ${likeCount}</button>
      </div>
    </article>`;
  }).join('');

  soutienWall.querySelectorAll('[data-like]').forEach(btn => {
    btn.addEventListener('click', () => toggleLike(btn.getAttribute('data-like')));
  });
}

const btnSoutien = el('btn-soutien');
const soutienModalBackdrop = el('soutien-modal-backdrop');
const btnCloseSoutienModal = el('btn-close-soutien-modal');
const soutienForm = el('soutien-form');
const soutienMessageInput = el('soutien-message');
const soutienPseudoInput = el('soutien-pseudo');
const soutienLieuInput = el('soutien-lieu');
const soutienCharCount = el('soutien-char-count');
const soutienWall = el('soutien-wall');
const soutienEmpty = el('soutien-empty');

// Affiche déjà le bandeau des forces engagées avant même toute connexion réseau
renderForcesBanner();

function openSoutienModal() {
  soutienForm.reset();
  soutienCharCount.textContent = '0';
  soutienModalBackdrop.classList.remove('hidden');
}
function closeSoutienModal() { soutienModalBackdrop.classList.add('hidden'); }

btnSoutien.addEventListener('click', openSoutienModal);
btnCloseSoutienModal.addEventListener('click', closeSoutienModal);
soutienModalBackdrop.addEventListener('click', (e) => { if (e.target === soutienModalBackdrop) closeSoutienModal(); });
soutienMessageInput.addEventListener('input', () => {
  soutienCharCount.textContent = String(soutienMessageInput.value.length);
});
soutienForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const message = soutienMessageInput.value.trim();
  const pseudo = soutienPseudoInput.value.trim();
  const lieu = soutienLieuInput.value.trim();
  if (!message) return;
  addSoutienMessage(message.slice(0, 200), pseudo.slice(0, 30), lieu.slice(0, 40));
  closeSoutienModal();
  showToast('Merci pour votre message');
});

/* =====================================================================
   TOAST
===================================================================== */

let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2200);
}

/* =====================================================================
   MODE DÉMONSTRATION : bouton, bandeau, sortie
===================================================================== */
function setDemoMode(on) {
  demoMode = on;
  demoAnnonces = on ? buildDemoAnnonces() : [];
  try { on ? sessionStorage.setItem('uei_demo', '1') : sessionStorage.removeItem('uei_demo'); } catch {}
  if (!on && new URLSearchParams(location.search).get('demo') === '1') {
    const u = new URL(location.href); u.searchParams.delete('demo'); history.replaceState(null, '', u);
  }
  filterType = 'all'; filterCat = 'all'; filterZone = 'all'; searchQuery = ''; currentPage = 1;
  const sb = document.getElementById('search-box'); if (sb) sb.value = '';
  renderDemoUI();
  renderFeed();
  showToast(on ? 'Mode démo : 30 annonces fictives' : 'Démo terminée : retour aux vraies annonces');
}
function renderDemoUI() {
  const banner = document.getElementById('demo-banner'), btn = document.getElementById('btn-demo');
  if (banner) banner.classList.toggle('hidden', !demoMode);
  if (btn) btn.hidden = demoMode; // pendant la démo, la sortie se fait par le bandeau
}
document.getElementById('btn-demo')?.addEventListener('click', () => setDemoMode(!demoMode));
document.getElementById('btn-demo-exit')?.addEventListener('click', () => setDemoMode(false));
document.getElementById('btn-demo-empty')?.addEventListener('click', () => setDemoMode(true));
renderDemoUI();

/* =====================================================================
   CRISE EN COURS : affichage depuis l'objet CRISE (haut du fichier)
===================================================================== */
function renderCrise() {
  const set = (id, fn) => { const n = document.getElementById(id); if (n) fn(n); };
  set('crise-line', n => n.setAttribute('data-actif', String(!!CRISE.actif)));
  set('crise-label', n => { n.textContent = CRISE.actif ? CRISE.intitule : 'Aucune crise en cours · le site reste prêt'; });
  set('info-title', n => { n.textContent = CRISE.titreInfo; });
  set('info-maj', n => { n.textContent = CRISE.maj ? `· mises à jour le ${CRISE.maj}` : ''; });
  set('info-resume', n => { n.innerHTML = CRISE.resume; });
  set('info-note', n => { n.textContent = CRISE.note || ''; });
  set('info-links', n => {
    n.innerHTML = CRISE.liens.map(l => `<li><a href="${escapeHTML(l.url)}" target="_blank" rel="noopener">${escapeHTML(l.label)}${ico('ext')}</a></li>`).join('');
  });
  set('dz-pref', n => { n.href = CRISE.prefecture.url; n.textContent = CRISE.prefecture.label; });
  set('forces-sub', n => { n.textContent = CRISE.forces; });
  document.title = CRISE.actif ? `Urgence Entraide — ${CRISE.intitule}` : 'Urgence Entraide — entraide citoyenne de proximité';
}
renderCrise();

/* =====================================================================
   BARRE D'ACTIONS MOBILE : réapparaît quand les deux grands boutons
   sortent de l'écran (les actions restent toujours à portée de pouce)
===================================================================== */
(function initMobileBar() {
  const bar = document.getElementById('mbar'), acts = document.getElementById('acts');
  if (!bar || !acts) return;
  bar.querySelectorAll('[data-proxy]').forEach(b => b.addEventListener('click', () => document.getElementById(b.dataset.proxy)?.click()));
  if (!('IntersectionObserver' in window)) return;
  new IntersectionObserver(([e]) => {
    const show = !e.isIntersecting;
    bar.classList.toggle('on', show);
    bar.setAttribute('aria-hidden', String(!show));
    bar.querySelectorAll('button').forEach(b => b.tabIndex = show ? 0 : -1);
  }).observe(acts);
})();

/* =====================================================================
   INIT — le fil est visible immédiatement (rendu local), la connexion
   au fil partagé se fait ensuite en arrière-plan sans bloquer l'UI.
===================================================================== */

async function init() {
  await initSync();          // on attend de savoir si on est connecté (max 4s)
  tryImportFromURL();        // ...avant d'importer un lien reçu, pour qu'il soit bien partagé si on est en ligne
  renderFeed();               // affiche l'annonce importée le cas échéant

  soutienCache = loadSoutienLocal();
  renderSoutienWall();
  renderTicker();
  const tickerInterval = setInterval(renderTicker, 5 * 60 * 1000); // rafraîchit les INFO toutes les 5 min
  if (typeof tickerInterval.unref === 'function') tickerInterval.unref();
  if (db) {
    pollSoutien(true);
    const t = setInterval(() => pollSoutien(false), POLL_INTERVAL_MS);
    if (typeof t.unref === 'function') t.unref();
  }
}
init();
