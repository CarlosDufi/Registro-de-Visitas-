'use strict';
/*
 * Two-step verification checked by our own server (TOTP, RFC 6238, with otplib). In this Firebase project (upgraded to
 * Identity Platform) the built-in TOTP enrolments are not kept, so the app uses this instead. Only supervisors and
 * admins. The secret lives in mfa/{uid}, a collection the rules close to every client: only this function reads it.
 *   mfaStatus             → { enrolled }
 *   mfaSetup              → new secret (kept as "pending" for 15 minutes) + otpauth:// address for the QR
 *   mfaConfirm { code }   → checks it against the pending secret and makes it the active one
 *   mfaVerify  { code }   → checks it against the active secret
 *   (both take remember:true → also a "remembered device" token for this browser, valid until the 12 hours run out)
 *   mfaDevice  { device } → a remembered device signs in again without the code (same 12 hours as the code it came from)
 *   mfaForget  { device } → forgets that device ("Sign out and forget this device")
 * They return a Firebase custom token with the claims mfa:'totp' and mfaAt (when the code was checked, in seconds).
 * The app signs in with it; the Firestore rules and manageUsers accept that session for 12 hours after mfaAt, then
 * the app asks for the code again. A password-only session never carries the claim.
 * Protections: 5 wrong codes → 15 minutes locked; each code is accepted only once (no replay); ±30 s clock margin.
 * Remembered devices: only a SHA-256 of the device token is stored; removing the verification (resetMfa) deletes them.
 */
const crypto = require('crypto');
const { authenticator } = require('otplib');

const ISSUER = 'Prestige Visitas';
const STEP_S = 30, MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000, PENDING_MS = 15 * 60 * 1000;
const TTL_S = 12 * 3600, MAX_DEVICES = 10;

// A session verified with the code in the last 12 hours (ID token claims)
const fresh = (token, nowMs) => !!token && token.mfa === 'totp' &&
  Number(token.mfaAt) * 1000 > (nowMs || Date.now()) - TTL_S * 1000;
const hashOf = (device) => crypto.createHash('sha256').update(String(device)).digest('hex');
const okDevice = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(v);
// Remembered devices still within their 12 hours (at most MAX_DEVICES, newest first)
function liveDevices(devices, t) {
  const out = {};
  Object.entries(devices || {})
    .filter(([, e]) => e && e.exp > t)
    .sort((a, b) => b[1].exp - a[1].exp)
    .slice(0, MAX_DEVICES)
    .forEach(([h, e]) => { out[h] = { at: e.at, exp: e.exp }; });
  return out;
}

class MfaError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const totpAt = (ms) => authenticator.clone({ window: 1, step: STEP_S, epoch: ms });

async function handle({ auth, db, caller, data, roleOf, now }) {
  const clock = now || Date.now;
  const role = await roleOf(db, caller.email);
  if (role === 'agent') throw new MfaError('permission-denied', 'Only supervisors and administrators');
  const ref = db.collection('mfa').doc(caller.uid);
  const action = data && data.action;

  if (action === 'mfaStatus') {
    const s = await ref.get();
    return { enrolled: !!(s.exists && s.data().secret) };
  }

  if (action === 'mfaSetup') {
    const s = await ref.get();
    if (s.exists && s.data().secret) throw new MfaError('failed-precondition', 'Two-step verification is already on');
    const secret = authenticator.generateSecret(20); // 160 bits, base32
    await ref.set({ pending: secret, pendingAt: clock() }, { merge: true });
    return { key: secret, url: authenticator.keyuri(caller.email || caller.uid, ISSUER, secret) };
  }

  if (action === 'mfaConfirm' || action === 'mfaVerify') {
    const code = String((data && data.code) || '').replace(/\D/g, '');
    if (code.length !== 6) throw new MfaError('invalid-argument', 'The code has 6 digits');
    const r = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const d = s.exists ? s.data() : {};
      const t = clock();
      if ((d.lockUntil || 0) > t) return { locked: true };
      const secret = action === 'mfaConfirm'
        ? (d.pending && t - (d.pendingAt || 0) < PENDING_MS ? d.pending : null)
        : d.secret;
      if (!secret) return { missing: true };
      const delta = totpAt(t).checkDelta(code, secret);
      const step = Math.floor(t / 1000 / STEP_S) + (delta || 0);
      // Wrong code, or a code already used (same or earlier time step): counts as a failed attempt
      if (delta === null || step <= (d.lastStep || 0)) {
        const fails = (d.fails || 0) + 1;
        tx.set(ref, fails >= MAX_FAILS ? { fails: 0, lockUntil: t + LOCK_MS } : { fails }, { merge: true });
        return { bad: true, locked: fails >= MAX_FAILS };
      }
      const at = Math.floor(t / 1000);
      const devices = liveDevices(d.devices, t);
      let device = null;
      if (data && data.remember === true) {
        device = crypto.randomBytes(32).toString('base64url');
        devices[hashOf(device)] = { at, exp: (at + TTL_S) * 1000 };
      }
      const fields = action === 'mfaConfirm'
        ? { secret, pending: null, pendingAt: null, enabledAt: t, lastStep: step, fails: 0, lockUntil: 0, devices: liveDevices(devices, t) }
        : { lastStep: step, fails: 0, lockUntil: 0, devices: liveDevices(devices, t) };
      tx.set(ref, fields, { mergeFields: Object.keys(fields) });
      return { ok: true, at, device };
    });
    if (r.locked) throw new MfaError('resource-exhausted', 'Too many attempts, try again in 15 minutes');
    if (r.missing) throw new MfaError('failed-precondition', action === 'mfaConfirm' ? 'Setup expired' : 'Two-step verification is not on');
    if (r.bad) throw new MfaError('invalid-argument', 'Wrong code');
    const out = { token: await auth.createCustomToken(caller.uid, { mfa: 'totp', mfaAt: r.at }), expires: (r.at + TTL_S) * 1000 };
    if (r.device) out.device = r.device;
    return out;
  }

  if (action === 'mfaDevice' || action === 'mfaForget') {
    if (!okDevice(data && data.device)) throw new MfaError('invalid-argument', 'Invalid device');
    const h = hashOf(data.device);
    const r = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists || !s.data().secret) return { missing: true };
      const t = clock();
      const devices = liveDevices(s.data().devices, t);
      const e = devices[h];
      if (action === 'mfaForget') delete devices[h];
      tx.set(ref, { devices }, { mergeFields: ['devices'] });
      return { e };
    });
    if (action === 'mfaForget') return { ok: true };
    if (r.missing || !r.e) throw new MfaError('failed-precondition', 'Device not remembered');
    return { token: await auth.createCustomToken(caller.uid, { mfa: 'totp', mfaAt: r.e.at }), expires: r.e.exp };
  }

  throw new MfaError('invalid-argument', 'Unknown action');
}

// mfa/{uid} documents with an active secret (for the users list)
async function enrolledUids(db) {
  const out = new Set();
  (await db.collection('mfa').get()).docs.forEach((d) => { if (d.data().secret) out.add(d.id); });
  return out;
}

module.exports = { MfaError, handle, enrolledUids, totpAt, fresh, STEP_S, TTL_S };
