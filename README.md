# FM foto Operatore V2 — Backend Drive

Obiettivo:
l'operaio usa FM foto su qualsiasi telefono senza login Google.

Flusso:
SCATTA → GPS → salvataggio locale → Cloudflare Worker → AI → Google Drive.

La root non contiene OAuth Google e non presenta configurazioni.

Database:
famaferFotoCantiere, schema v7, migrazione non distruttiva.

Backend:
vedi /backend-worker/worker.js

Per completare il backend vanno configurati una sola volta su Cloudflare i secrets Google.
