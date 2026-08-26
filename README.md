# FM Foto Operatore V2.7.6.1 — Tag Cleanup Fix

## Correzione
Il tag `da classificare` è un segnaposto e non deve convivere con tag reali.

Nuova regola:
- solo `da classificare` -> resta visibile;
- `da classificare + scala` -> diventa `scala`;
- `da classificare + ringhiera + parapetto` -> diventa `ringhiera + parapetto`;
- aggiunta manuale di un tag reale -> `da classificare` viene rimosso subito;
- risposta Gemini con tag reali -> placeholder rimosso;
- import PC già taggato -> placeholder rimosso;
- Archivio, Tag, Mappa e scheda foto mostrano sempre i tag ripuliti.

## Dati già presenti
All'avvio la PWA ripulisce automaticamente anche le foto locali già esistenti.

## Worker
Nessuna modifica al Worker Gemini V2.11.1.
