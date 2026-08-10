# FM foto Backend V2

Il Worker sostituisce quello AI attuale e gestisce:
1. classificazione Workers AI;
2. autenticazione Google Drive server-side;
3. caricamento Drive.

Binding già esistente:
- AI = Workers AI

Secrets da aggiungere a Cloudflare:
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- GOOGLE_REFRESH_TOKEN
- DRIVE_ROOT_FOLDER_ID

DRIVE_ROOT_FOLDER_ID:
1w9dy7R8VXFqpZjyvZ2oRBVPfn0ThVnC1

NON inserire i secret dentro worker.js.

Test:
GET /
GET /drive-test
POST /process
