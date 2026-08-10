# FM Foto Operatore V2.7.3 — iPhone EXIF Fix

## Obiettivo
Correggere data e posizione delle foto importate direttamente dalla galleria smartphone.

## Correzioni
- exifr passa dal bundle `lite` al bundle `full` 7.1.3;
- EXIF viene letto sul file ORIGINALE prima della compressione;
- data in priorità:
  1. DateTimeOriginal
  2. CreateDate
  3. DateTime
  4. ModifyDate
  5. File.lastModified
  6. solo come ultima risorsa: ora di importazione;
- GPS in priorità:
  1. parse EXIF completo;
  2. `exifr.gps(file)` dedicato;
- coordinate validate;
- salva `dateSource` e `gpsSource` per diagnostica;
- Archivio mostra l'origine del dato quando disponibile;
- DB schema v16 non distruttivo;
- cache PWA aggiornata a 7.7.3.

## Limite iPhone/iOS
Se l'utente, nel selettore Foto di iOS, sceglie di non condividere la posizione,
il browser riceve il file senza quella metadata. In quel caso FM Foto non può
ricostruire coordinate assenti e mostrerà "Posizione non presente nel file selezionato".

## Installazione
Aggiornare SOLO i file GitHub/PWA.
NON modificare il Worker Cloudflare V2.9.
