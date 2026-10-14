# Funciones de Firebase y reglas de Firestore

Copia de referencia del código que está desplegado en el proyecto de Firebase `hoja-de-visitas`.
Guardarlo aquí **no despliega nada**: las funciones y las reglas se siguen publicando desde Firebase.

## Contenido

- `index.js`: funciones `searchProperties`, `searchContacts` y `syncViewing` (región `europe-west1`).
- `crm.js`: llamadas a la API de Respacio y creación del evento "Viewing" en el CRM.
- `../firestore.rules`: reglas de Firestore publicadas en la consola de Firebase.

Las credenciales de Respacio (`RESPACIO_BASIC`, `RESPACIO_API_KEY`) están en los secretos de Firebase, no en el código.

## Pendiente

- **Edición de eventos en Respacio.** Enviar `event_id` a `add_viewing_feedback_event` crea un evento nuevo en lugar de
  editar el existente (comprobado: al guardar valoración o comentario cambia el número de evento). Falta que Respacio
  confirme el endpoint y el parámetro para editar; el cambio va en `CFG` (`crm.js`).
- **`package.json`.** No está incluido. Para desplegar desde este repositorio hay que copiarlo de la carpeta `functions`
  original (dependencias `firebase-functions` y `firebase-admin`), junto con `firebase.json` si existe.

## Desplegar (cuando haga falta)

Desde la carpeta del proyecto, con las herramientas de Firebase instaladas y la sesión iniciada:

```
firebase deploy --only functions
firebase deploy --only firestore:rules
```
