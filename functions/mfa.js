'use strict';
/*
 * Two-step verification checked by our own server (TOTP, RFC 6238, with otplib). In this Firebase project (upgraded to
 * Identity Platform) the built-in TOTP enrolments are not kept, so the app uses this instead. Only supervisors and
 * admins. The secret lives in mfa/{uid}, a collection the rules close to every client: only this function reads it.
 *   mfaStatus             → { enrolled }
 *   mfaSetup              → new secret (kept as "pending" for 15 minutes) + otpauth:// address for the QR
 *   mfaConfirm { code }   → checks it against the pending secret and makes it the active one
 *   mfaVerify  { code }   → checks it against the active secret
 * Confirm and verify return a Firebase custom token with the claim mfa:'totp'. The app signs in with it, so only that
 * session carries the claim the Firestore rules and REQUIRE_MFA ask for (a password-only session does not).
 * Protections: 5 wrong codes → 15 minutes locked; each code is accepted only once (no replay); ±30 s clock margin.
 */
const { authenticator } = require('otplib');

const ISSUER = 'Prestige Visitas';
const STEP_S = 30, MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000, PENDING_MS = 15 * 60 * 1000;

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
      tx.set(ref, action === 'mfaConfirm'
        ? { secret, pending: null, pendingAt: null, enabledAt: t, lastStep: step, fails: 0, lockUntil: 0 }
        : { lastStep: step, fails: 0, lockUntil: 0 }, { merge: true });
      return { ok: true };
    });
    if (r.locked) throw new MfaError('resource-exhausted', 'Too many attempts, try again in 15 minutes');
    if (r.missing) throw new MfaError('failed-precondition', action === 'mfaConfirm' ? 'Setup expired' : 'Two-step verification is not on');
    if (r.bad) throw new MfaError('invalid-argument', 'Wrong code');
    return { token: await auth.createCustomToken(caller.uid, { mfa: 'totp' }) };
  }

  throw new MfaError('invalid-argument', 'Unknown action');
}

// mfa/{uid} documents with an active secret (for the users list)
async function enrolledUids(db) {
  const out = new Set();
  (await db.collection('mfa').get()).docs.forEach((d) => { if (d.data().secret) out.add(d.id); });
  return out;
}

module.exports = { MfaError, handle, enrolledUids, totpAt, STEP_S };
