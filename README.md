# FM Foto Operatore V2.7.7 — Archive Delete

Base: V2.7.6.5 funzionante.
DB_VERSION resta 22.

## Archivio
In modalità `Seleziona` compaiono:
- Condividi (N)
- 🗑 Elimina (N)

La cancellazione:
1. chiede conferma;
2. elimina la foto dal Google Drive condiviso tramite `/delete-photo`;
3. elimina la copia locale dal dispositivo;
4. aggiorna Archivio, Tag e Mappa;
5. sugli altri dispositivi la foto scompare al successivo refresh/sincronizzazione.

Se Drive fallisce, la copia locale NON viene cancellata per evitare perdita del riferimento.

## Worker
Richiede Worker FM Foto V2.12 con endpoint POST `/delete-photo`.
