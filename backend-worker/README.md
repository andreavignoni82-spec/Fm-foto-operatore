# FM foto Backend V2.1

Binding:
- AI = Workers AI

Secrets Cloudflare:
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- GOOGLE_REFRESH_TOKEN

Variabile:
- GOOGLE_DRIVE_FOLDER_ID

Valore cartella:
1w9dy7R8VXFqpZjyvZ2oRBVPfn0ThVnC1

Test dopo il deploy:
1. GET /
   Deve mostrare version 2.1 e tutti i campi config = true.
2. GET /drive-test
   Deve restituire ok:true e il nome della cartella Drive.
3. Solo dopo, pubblicare la V2 Operatore su GitHub Pages.
