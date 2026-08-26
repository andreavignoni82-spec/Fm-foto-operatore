FM Foto Operatore V2.7.6.5 — TAG LABEL FIX

Partenza: V2.7.6.4 funzionante.
DB_VERSION resta 22.

Regola visiva:
- nessun tag reale -> `da classificare`;
- almeno un tag reale -> `da classificare` non viene mostrato.

La funzione usa una copia temporanea della foto esclusivamente per costruire la card:
non modifica IndexedDB, non migra dati, non altera Archivio/Mappa/Drive.
Worker Gemini invariato.
