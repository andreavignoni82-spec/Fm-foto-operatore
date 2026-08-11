# FM Foto Operatore V2.7.4.1 — AI Status Timeout Fix

Questa versione mantiene integralmente:
- AI Fix V2.7.4
- EXIF/Data/GPS Fix V2.7.3
- Queue Fix V2.7.2

## Correzione
Il controllo iniziale AI non può più restare bloccato su:
`AI: verifica in corso…`

Nuovo comportamento:
- timeout massimo: 5 secondi;
- gestione HTTP;
- gestione JSON non valido;
- gestione rete/CORS;
- stato binding AI esplicito;
- un solo retry automatico dopo circa 1,8 secondi.

## Stati possibili
- AI: disponibile · Worker X
- AI: binding Cloudflare non configurato
- AI: Worker raggiungibile · stato binding non dichiarato
- AI: verifica scaduta · backend lento/non raggiungibile
- AI: backend non raggiungibile
- AI/backend: HTTP NNN

## Installazione
Aggiornare solo GitHub/PWA.
Worker Cloudflare invariato: V2.9+.
