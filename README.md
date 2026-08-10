# FM foto Operatore V2.7.1 — Queue Loop Fix

Correzione V2.7:
- eliminato il loop infinito del pulsante "Riprova non sincronizzate";
- ogni foto viene tentata al massimo una volta per ogni ciclo della coda;
- una foto fallita resta in stato ERRORE e non viene ripresa immediatamente;
- un nuovo tentativo avviene solo premendo di nuovo Riprova;
- se il backend non conferma driveUploaded, la foto passa a ERRORE anziché tornare pending;
- pulsante Retry disabilitato mentre una coda è in elaborazione;
- contatori pending/processing separati correttamente;
- database v14, migrazione non distruttiva;
- Worker V2.6 invariato.

Aggiorna solo i file GitHub/PWA.
