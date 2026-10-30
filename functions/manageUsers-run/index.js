'use strict';
/*
 * Cloud Run function (2nd gen) "manageUsers" for the "Usuarios" page. The Google Cloud console no longer creates
 * 1st-gen functions, so this one is a plain HTTP function that speaks the same protocol as the callable ones
 * (request {data}, response {result} or {error:{status,message}}) and checks the Firebase sign-in token itself.
 * users.js is the same file as functions/users.js.
 */
const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');
const users = require('./users');

admin.initializeApp();
const db = admin.firestore();

const HTTP = { 'invalid-argument': 400, 'failed-precondition': 400, unauthenticated: 401, 'permission-denied': 403, 'not-found': 404, 'already-exists': 409, internal: 500 };
const fail = (res, code, message) =>
  res.status(HTTP[code] || 500).json({ error: { status: code.toUpperCase().replace(/-/g, '_'), message } });

functions.http('manageUsers', async (req, res) => {
  // The app is a web page on another domain; every request still needs a valid sign-in token
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return fail(res, 'invalid-argument', 'POST only');

  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  let token;
  // checkRevoked: a disabled or deleted user is rejected even if their token has not expired yet
  try { token = await admin.auth().verifyIdToken(m ? m[1] : '', true); } catch (e) { return fail(res, 'unauthenticated', 'Sign in required'); }

  try {
    const caller = { uid: token.uid, email: String(token.email || '').toLowerCase() };
    const result = await users.manage({ auth: admin.auth(), db, caller, data: (req.body && req.body.data) || {} });
    res.status(200).json({ result });
  } catch (e) {
    if (e instanceof users.UserError) return fail(res, e.code, e.message);
    console.error('manageUsers error:', e && e.code, e && e.message);
    fail(res, 'internal', 'Unexpected error');
  }
});
