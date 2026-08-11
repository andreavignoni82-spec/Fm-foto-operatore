# FM Foto Operatore V2.7.4 — AI Fix

Mantiene integralmente il fix V2.7.3 per EXIF/Data/GPS.

Correzioni:
- nuova foto → POST /process sempre eseguito;
- `skipAI:false` esplicito per la PWA smartphone;
- `capturedAt` usa il dato originale se presente;
- risultato del Worker rispettato realmente (`aiStatus`, `aiError`);
- non marca più `classified` quando Cloudflare AI ha fallito;
- retry e import archivio usano la stessa logica;
- indicatore AI visibile nell'app;
- verifica binding AI all'avvio;
- Drive continua a funzionare anche con AI temporaneamente KO.

Worker richiesto: FM Foto V2.9+.
Aggiornare solo GitHub/PWA.
