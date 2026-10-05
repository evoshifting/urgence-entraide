// Service worker de retrait (ancienne adresse) : remplace l'ancien worker hors-ligne chez les
// visiteurs qui l'avaient installé, vide ses caches, se désinscrit et recharge les pages ouvertes,
// qui tombent alors sur la redirection vers https://urgence-entraide.web.app.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
  })());
});
