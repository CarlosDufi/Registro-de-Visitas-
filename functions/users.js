'use strict';
/*
 * User management for administrators (Firebase Auth + Firestore roles).
 * Roles: agent (no document), supervisor (supervisores/{email}), admin (admins/{email} + supervisores/{email}).
 * Names: Firebase Auth displayName, copied to usuarios/{email} {name} so every signed-in user can show it in viewings
 * and PDFs (kept after deleting a user, so old viewings keep the name).
 * Every action checks that the caller is an admin. An admin cannot change their own role, disable or delete themselves,
 * so the app never runs out of administrators.
 */
const ROLES = ['agent', 'supervisor', 'admin'];

class UserError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const lower = (s) => String(s || '').trim().toLowerCase();
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
const okEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 120;
const okPass = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 100;

async function isAdmin(db, email) {
  if (!email) return false;
  return (await db.collection('admins').doc(lower(email)).get()).exists;
}

async function roleOf(db, email) {
  const e = lower(email);
  if (!e) return 'agent';
  const [a, s] = await Promise.all([db.collection('admins').doc(e).get(), db.collection('supervisores').doc(e).get()]);
  return a.exists ? 'admin' : s.exists ? 'supervisor' : 'agent';
}

async function setRole(db, email, role) {
  const e = lower(email);
  const adm = db.collection('admins').doc(e), sup = db.collection('supervisores').doc(e);
  if (role === 'admin') { await adm.set({ email: e }, { merge: true }); await sup.set({ email: e }, { merge: true }); }
  else if (role === 'supervisor') { await adm.delete(); await sup.set({ email: e }, { merge: true }); }
  else { await adm.delete(); await sup.delete(); }
}

async function setName(db, email, name) {
  const e = lower(email);
  if (!e) return;
  const ref = db.collection('usuarios').doc(e);
  if (name) await ref.set({ name }, { merge: true }); else await ref.delete();
}

function authErr(e) {
  const c = (e && e.code) || '';
  if (c === 'auth/email-already-exists') return new UserError('already-exists', 'This email already has a user');
  if (c === 'auth/invalid-email') return new UserError('invalid-argument', 'Invalid email');
  if (c === 'auth/invalid-password') return new UserError('invalid-argument', 'Invalid password');
  if (c === 'auth/user-not-found') return new UserError('not-found', 'User not found');
  return e;
}

async function list(auth, db) {
  const out = [];
  let token;
  do {
    const r = await auth.listUsers(1000, token);
    for (const u of r.users) {
      out.push({
        uid: u.uid, email: u.email || '', name: u.displayName || '', disabled: !!u.disabled,
        lastSignIn: u.metadata && u.metadata.lastSignInTime ? Date.parse(u.metadata.lastSignInTime) || null : null,
        role: await roleOf(db, u.email),
      });
    }
    token = r.pageToken;
  } while (token);
  out.sort((a, b) => a.email.localeCompare(b.email));
  // Keeps usuarios/{email} in step with the names in Auth (users created or renamed in the Firebase console)
  const saved = {};
  (await db.collection('usuarios').get()).docs.forEach((d) => { saved[d.id] = d.data().name || ''; });
  for (const u of out) {
    const e = lower(u.email);
    if (e && (saved[e] || '') !== u.name) await setName(db, e, u.name);
  }
  return out;
}

/*
 * data.action: 'list' | 'create' {email, name, password, role} | 'update' {uid, name?, password?, role?, disabled?} | 'delete' {uid}
 * caller: { uid, email } from the sign-in token.
 */
async function manage({ auth, db, caller, data }) {
  if (!(await isAdmin(db, caller.email))) throw new UserError('permission-denied', 'Only administrators');
  const d = data || {};
  const action = d.action;

  if (action === 'list') return { users: await list(auth, db) };

  if (action === 'create') {
    const email = lower(d.email), name = cleanName(d.name), role = d.role || 'agent';
    if (!okEmail(email)) throw new UserError('invalid-argument', 'Invalid email');
    if (!okPass(d.password)) throw new UserError('invalid-argument', 'The password must have at least 8 characters');
    if (!ROLES.includes(role)) throw new UserError('invalid-argument', 'Invalid role');
    let u;
    try { u = await auth.createUser({ email, password: d.password, displayName: name || undefined }); } catch (e) { throw authErr(e); }
    await setRole(db, email, role);
    if (name) await setName(db, email, name);
    return { uid: u.uid };
  }

  if (action === 'update' || action === 'delete') {
    const uid = typeof d.uid === 'string' ? d.uid : '';
    if (!uid || uid.length > 128) throw new UserError('invalid-argument', 'Invalid user');
    let u;
    try { u = await auth.getUser(uid); } catch (e) { throw authErr(e); }
    const self = uid === caller.uid;

    if (action === 'delete') {
      if (self) throw new UserError('failed-precondition', 'You cannot delete yourself');
      try { await auth.deleteUser(uid); } catch (e) { throw authErr(e); }
      if (u.email) await setRole(db, u.email, 'agent');
      return { ok: true };
    }

    const upd = {};
    if (d.name !== undefined) upd.displayName = cleanName(d.name) || null;
    if (d.password !== undefined) {
      if (!okPass(d.password)) throw new UserError('invalid-argument', 'The password must have at least 8 characters');
      upd.password = d.password;
    }
    if (d.disabled !== undefined) {
      if (self) throw new UserError('failed-precondition', 'You cannot disable yourself');
      upd.disabled = !!d.disabled;
    }
    if (d.role !== undefined) {
      if (self) throw new UserError('failed-precondition', 'You cannot change your own role');
      if (!ROLES.includes(d.role)) throw new UserError('invalid-argument', 'Invalid role');
      if (!u.email) throw new UserError('failed-precondition', 'The user has no email');
    }
    if (Object.keys(upd).length) { try { await auth.updateUser(uid, upd); } catch (e) { throw authErr(e); } }
    if (d.role !== undefined) await setRole(db, u.email, d.role);
    if (d.name !== undefined && u.email) await setName(db, u.email, cleanName(d.name));
    return { ok: true };
  }

  throw new UserError('invalid-argument', 'Unknown action');
}

module.exports = { ROLES, UserError, manage, isAdmin, roleOf, setRole, setName };
