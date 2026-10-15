# Funciones de Firebase y reglas de Firestore

Copia de referencia del código que está desplegado en el proyecto de Firebase `hoja-de-visitas`.
Guardarlo aquí **no despliega nada**: las funciones y las reglas se siguen publicando desde Firebase.

## Contenido

- `index.js`: funciones `searchProperties`, `searchContacts` y `syncViewing` (región `europe-west1`).
- `crm.js`: llamadas a la API de Respacio; creación y actualización del evento "Viewing" en el CRM.
- `package.json`: dependencias (Node 22, `firebase-functions` 7, `firebase-admin` 13), copiado de la consola.
- `../firestore.rules`: reglas de Firestore publicadas en la consola de Firebase.

Las credenciales de Respacio (`RESPACIO_BASIC`, `RESPACIO_API_KEY`) están en los secretos de Firebase, no en el código.

## Estado

- **Edición de eventos (desplegado en `syncViewing`).** `syncVisit` crea el evento con `add_viewing_feedback_event` la
  primera vez y, si la visita ya tiene `crm.eventId`, actualiza sus notas con `update_viewing_event` (`event_id` + `notes`),
  sin crear otro.
- **Búsqueda de contactos.** Respacio busca en `contact_number_suggestion` por nombre, apellido, nombre completo, móvil o
  correo y devuelve como máximo 20 contactos; la app los ordena poniendo primero los que coinciden con lo escrito.

- **Propiedades privadas.** `searchProperties` envía `include_private=1` a `reference_no_suggestion` para incluir las
  propiedades privadas en la web (indicado por Respacio). Se despliega en la función `searchProperties`.

## Pendiente

- **Varias propiedades.** Con varias propiedades Respacio crea un evento por propiedad pero devuelve un solo `event_id`;
  falta confirmar con ellos cómo actualizar todos.

## Desplegar (cuando haga falta)

**Desde la consola (lo más sencillo):** Google Cloud → Funciones de Cloud Run → `syncViewing` → pestaña **Fuente** →
**Editar** → sustituir el contenido de `crm.js` por el de este repositorio → **Implementar**. Cada función (`syncViewing`,
`searchContacts`, `searchProperties`) tiene su propio código desplegado: hay que actualizar la que use lo que cambia. Para volver atrás, elegir una versión anterior en el desplegable «Versión».
No pulsar «Actualizar» a Cloud Run Functions (2.ª generación).

**Desde un ordenador**, en la carpeta del proyecto, con las herramientas de Firebase instaladas y la sesión iniciada
(falta `firebase.json` en el repositorio para este camino):

```
firebase deploy --only functions
firebase deploy --only firestore:rules
```
