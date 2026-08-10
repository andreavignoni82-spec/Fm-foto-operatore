# FM foto Operatore V2.7 — Import Queue Resiliente

Questa versione NON richiede modifiche al Worker V2.6.

Novità:
- durante import multiplo tutte le foto vengono prima salvate in IndexedDB;
- AI/Drive partono solo dopo, in una coda separata;
- elaborazione sequenziale, una foto alla volta;
- una foto in errore non interrompe le successive;
- ripresa automatica dopo chiusura browser / refresh / perdita rete;
- stato persistente: In coda / Elaborazione / Da riprovare / Drive;
- contatori della coda;
- barra avanzamento;
- pulsante "Riprova non sincronizzate";
- il retry generico non elabora più le foto importate, evitando doppie code;
- database v13 con migrazione non distruttiva;
- Worker Cloudflare V2.6 invariato.

Nota:
le foto vengono considerate al sicuro appena sono state salvate localmente.
La sincronizzazione può proseguire successivamente.
