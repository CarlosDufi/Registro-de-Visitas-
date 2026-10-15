'use strict';
const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const crm = require('./crm');

admin.initializeApp();
const db = admin.firestore();

// europe-west1 is close to Ibiza. The credentials live in Firebase secrets, never in the app.
const fn = functions
  .region('europe-west1')
  .runWith({ secrets: ['RESPACIO_BASIC', 'RESPACIO_API_KEY'], timeoutSeconds: 60, memory: '256MB' });

const { HttpsError } = functions.https;

function needAuth(ctx) {
  if (!ctx.auth) throw new HttpsError('unauthenticated', 'Sign in required');
}
function cleanQuery(q) {
  const s = typeof q === 'string' ? q.trim() : '';
  return s.length >= 2 && s.length <= 40 ? s : '';
}
function toHttps(e) {
  console.error('Respacio error:', e && e.code, e && e.message);
  if (e instanceof crm.CrmError) {
    const map = { config: 'failed-precondition', timeout: 'deadline-exceeded', network: 'unavailable', bad_response: 'unavailable' };
    return new HttpsError(map[e.code] || 'unknown', e.message);
  }
  return new HttpsError('internal', 'Unexpected error');
}

// Dropdown of properties while the agent types a reference number.
exports.searchProperties = fn.https.onCall(async (data, ctx) => {
  needAuth(ctx);
  const q = cleanQuery(data && data.q);
  if (!q) return { items: [] };
  try { return { items: await crm.searchProperties(q) }; } catch (e) { throw toHttps(e); }
});

// Dropdown of clients while the agent types.
exports.searchContacts = fn.https.onCall(async (data, ctx) => {
  needAuth(ctx);
  const q = cleanQuery(data && data.q);
  if (!q) return { items: [] };
  try { return { items: await crm.searchContacts(q) }; } catch (e) { throw toHttps(e); }
});

// Creates the "Viewing" event for a saved visit, or updates its notes if the event already exists.
// With "link" it first links the CRM properties chosen by the agent (visits saved without a linked property).
exports.syncViewing = fn.https.onCall(async (data, ctx) => {
  needAuth(ctx);
  const visitId = data && typeof data.visitId === 'string' ? data.visitId : '';
  if (!/^[A-Za-z0-9_\-]{1,80}$/.test(visitId)) throw new HttpsError('invalid-argument', 'Invalid visit');
  // The CRM user is the signed-in agent, taken from the login token (not from the request).
  const email = String((ctx.auth.token && ctx.auth.token.email) || '').toLowerCase();
  if (!email) throw new HttpsError('failed-precondition', 'The user has no email');
  // Optional: link CRM properties to a visit saved without them ([{ i, id, ref }])
  let link = null;
  if (data && data.link !== undefined) {
    const ok = Array.isArray(data.link) && data.link.length >= 1 && data.link.length <= 10 && data.link.every((l) =>
      l && Number.isInteger(l.i) && l.i >= 0 && l.i < 10 && Number.isInteger(l.id) && l.id > 0 &&
      (l.ref === undefined || (typeof l.ref === 'string' && l.ref.length <= 40)));
    if (!ok || new Set(data.link.map((l) => l.i)).size !== data.link.length) throw new HttpsError('invalid-argument', 'Invalid link');
    link = data.link.map((l) => ({ i: l.i, id: l.id, ref: String(l.ref || '').trim() }));
  }
  const r = await crm.syncVisit({ db, visitId, uid: ctx.auth.uid, email, link });
  if (r.error) throw new HttpsError(r.error, r.error);
  return r;
});
