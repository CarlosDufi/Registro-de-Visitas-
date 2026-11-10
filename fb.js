/* Conexión con Firebase: SDK modular 13.1.0 (la misma versión que CRM-analytics) con la misma forma que la versión «compat» que usaba la app
   (firebase.initializeApp / auth() / firestore()), para no cambiar el resto del código. Los módulos se cargan al
   arrancar y cada operación espera a que estén listos. Incluye la verificación en dos pasos con app de códigos
   (TOTP), que la versión «compat» no ofrece: window.fbMfa y el campo `mfa` del error al iniciar sesión.
   También signInWithCustomToken, para la verificación en dos pasos propia (la comprueba la función manageUsers).
   Si ya existe window.firebase (pruebas con Firebase simulado), no hace nada. */
(function () {
  if (window.firebase) return;
  const V = 'https://www.gstatic.com/firebasejs/13.1.0/';
  const ISSUER = 'Prestige Visitas';
  let cfg = null, ready = null, A = null, F = null, auth = null, db = null, persistOk = false, lang = null;
  const emu = {};
  const W = f => (ready || Promise.reject(new Error('firebase-not-initialized'))).then(f);

  function start() {
    ready = Promise.all([import(V + 'firebase-app.js'), import(V + 'firebase-auth.js'), import(V + 'firebase-firestore.js')])
      .then(([ap, au, fs]) => {
        A = au; F = fs;
        const app = ap.initializeApp(cfg);
        auth = au.getAuth(app);
        if (emu.auth) au.connectAuthEmulator(auth, emu.auth, { disableWarnings: true });
        if (lang) auth.languageCode = lang;
        // Caché sin conexión compartida entre pestañas (equivale a enablePersistence({synchronizeTabs:true}))
        try {
          db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
          persistOk = true;
        } catch (e) {
          db = fs.initializeFirestore(app, {});
        }
        if (emu.fs) fs.connectFirestoreEmulator(db, emu.fs[0], emu.fs[1]);
      });
    ready.catch(() => {});
  }

  /* ===== Firestore ===== */
  const docSnap = s => ({ id: s.id, exists: s.exists(), data: () => s.data(), metadata: s.metadata });
  function docRef(path) {
    const r = () => F.doc(db, ...path);
    return {
      id: path[path.length - 1], _ref: r,
      get(o) { return W(() => (o && o.source === 'cache' ? F.getDocFromCache(r()) : F.getDoc(r())).then(docSnap)); },
      set(d, o) { return W(() => (o ? F.setDoc(r(), d, o) : F.setDoc(r(), d))); },
      update(d) { return W(() => F.updateDoc(r(), d)); },
      delete() { return W(() => F.deleteDoc(r())); },
    };
  }
  function coll(name, cons) {
    const q = () => (cons.length ? F.query(F.collection(db, name), ...cons.map(c => F.where(c[0], c[1], c[2]))) : F.collection(db, name));
    return {
      where(a, b, c) { return coll(name, cons.concat([[a, b, c]])); },
      doc(id) { return docRef([name, id]); },
      onSnapshot(next, err) {
        let un = null, off = false;
        W(() => {
          if (off) return;
          un = F.onSnapshot(q(), s => next({ docs: s.docs.map(d => ({ id: d.id, data: () => d.data() })), metadata: s.metadata }), err);
        }).catch(e => { if (err) err(e); });
        return () => { off = true; if (un) un(); };
      },
    };
  }
  const dbObj = {
    collection: name => coll(name, []),
    batch() {
      const ops = [];
      return {
        set(ref, d) { ops.push([ref, d]); return this; },
        commit() { return W(() => { const b = F.writeBatch(db); ops.forEach(([ref, d]) => b.set(ref._ref(), d)); return b.commit(); }); },
      };
    },
    enablePersistence() { return W(() => { if (!persistOk) throw new Error('no-persistence'); }); },
    terminate() { return W(() => F.terminate(db)); },
    clearPersistence() { return W(() => F.clearIndexedDbPersistence(db)); },
    useEmulator(host, port) { emu.fs = [host, port]; },
  };

  /* ===== Authentication ===== */
  const authObj = {
    onAuthStateChanged(cb) {
      let un = null, off = false;
      W(() => { if (!off) un = A.onAuthStateChanged(auth, cb); });
      return () => { off = true; if (un) un(); };
    },
    // Con verificación en dos pasos, el error 'auth/multi-factor-auth-required' lleva `mfa.resolve(código)`
    signInWithEmailAndPassword(email, pass) {
      return W(() => A.signInWithEmailAndPassword(auth, email, pass).catch(err => {
        if (err && err.code === 'auth/multi-factor-auth-required') {
          const res = A.getMultiFactorResolver(auth, err);
          const h = res.hints.find(x => x.factorId === 'totp') || res.hints[0];
          err.mfa = h ? { resolve: code => res.resolveSignIn(A.TotpMultiFactorGenerator.assertionForSignIn(h.uid, code)) } : null;
        }
        throw err;
      }));
    },
    // Sesión nueva con la marca mfa:'totp' que devuelve nuestro servidor tras comprobar el código (verificación propia)
    signInWithCustomToken(t) { return W(() => A.signInWithCustomToken(auth, t).then(c => c.user)); },
    signOut() { return W(() => A.signOut(auth)); },
    sendPasswordResetEmail(email) { return W(() => A.sendPasswordResetEmail(auth, email)); },
    useEmulator(url) { emu.auth = url; },
    get languageCode() { return lang; },
    set languageCode(v) { lang = v; if (auth) auth.languageCode = v; },
  };

  /* ===== Verificación en dos pasos (app de códigos) ===== */
  window.fbMfa = {
    // Estado de la verificación en dos pasos para la sesión actual:
    //  'ok'       la sesión se inició con el código (lo que exigen las reglas);
    //  'relogin'  la cuenta ya la tiene, pero esta sesión se abrió sin el código (hay que salir y volver a entrar);
    //  'setup'    la cuenta no la tiene: hay que activarla.
    // Antes pide a Firebase los datos al día de la cuenta; si la sesión ya no vale, la cierra para volver a entrar.
    // Sin conexión, usa la copia guardada.
    status(user) {
      return W(async () => {
        try { await A.reload(user); } catch (e) {
          const c = (e && e.code) || '';
          if (/user-token-expired|invalid-user-token|user-disabled|user-not-found/.test(c)) { await A.signOut(auth); throw e; }
        }
        let second = null;
        try { second = (await user.getIdTokenResult()).signInSecondFactor; } catch (e) {}
        if (second) return 'ok';
        return A.multiFactor(user).enrolledFactors.length ? 'relogin' : 'setup';
      });
    },
    // Empieza la configuración: clave secreta + dirección otpauth:// para el QR; finish(código) la completa
    async start(user) {
      await ready;
      // Como en CRM-analytics: datos al día y, si el correo ya está verificado pero la sesión aún no lo refleja
      // (se verificó desde el servidor), se renueva la sesión antes de activar la verificación.
      await A.reload(user);
      if (!user.emailVerified) { const e = new Error('unverified'); e.code = 'auth/unverified-email'; throw e; }
      if (!(await user.getIdTokenResult()).claims.email_verified) await user.getIdToken(true);
      const session = await A.multiFactor(user).getSession();
      const secret = await A.TotpMultiFactorGenerator.generateSecret(session);
      return {
        key: secret.secretKey,
        url: secret.generateQrCodeUrl(user.email || '', ISSUER),
        finish: async code => {
          await A.multiFactor(user).enroll(A.TotpMultiFactorGenerator.assertionForEnrollment(secret, code), 'App de codigos');
          await user.getIdToken(true);
        },
      };
    },
  };

  window.firebase = {
    initializeApp(c) { if (!ready) { cfg = c; start(); } },
    auth: () => authObj,
    firestore: () => dbObj,
  };
})();
