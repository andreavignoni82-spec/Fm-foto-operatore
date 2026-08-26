# FM Foto Operatore V2.7.6.4 — DB Recovery Fix

## Problema corretto
La V2.7.6.1 aveva già aggiornato IndexedDB alla versione 22.
Le versioni successive impostate a DB_VERSION 21 generavano:

VersionError: The requested version (21) is less than the existing version (22)

## Soluzione
- DB_VERSION riportato correttamente a 22.
- Nessuna cancellazione database.
- Nessuna migrazione dati.
- Nessuna modifica alle foto esistenti.
- Archivio, Tag, Mappa e gruppi foto restano quelli della base funzionante.
- Fix visivo `da classificare` mantenuto in modo non distruttivo.
- Worker Gemini V2.11.1 invariato.

Dopo il deploy, aggiornare forzatamente la pagina/PWA.
