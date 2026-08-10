# FM foto Operatore V2.7.2 — iPhone Import Queue Fix

Worker richiesto: V2.8 (invariato).

Correzioni:
- import da galleria iPhone salva prima le foto localmente;
- al termine attende esplicitamente la coda di upload;
- nuovo pulsante "Avvia caricamento";
- nuovo pulsante "Riprova errori";
- blocco anti-doppia coda;
- una singola foto viene processata una sola volta per ciclo;
- pausa maggiore tra upload per iOS/Safari;
- stato AI letto dal Worker: se quota AI esaurita la foto può risultare da classificare ma Drive è comunque sincronizzato;
- DB v15 non distruttivo.

Aggiorna solo GitHub/PWA. Non cambiare il Worker V2.8.
