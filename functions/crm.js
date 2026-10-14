'use strict';
/*
 * Respacio CRM helpers (no Firebase dependencies, so they can be tested on their own).
 * Everything that is likely to need adjusting after IT confirms the API is in CFG.
 */
const BASE = 'https://crm.respacio.com/ws/properties/';
const CFG = {
  urls: {
    properties: BASE + 'reference_no_suggestion',
    contacts: BASE + 'contact_number_suggestion',
    event: BASE + 'add_viewing_feedback_event',
  },
  // HTTP methods as written in the original API document (to be confirmed by IT)
  methods: { properties: 'POST', contacts: 'GET', event: 'POST' },
  // 'form' = application/x-www-form-urlencoded (arrays as property_arr[]=1&property_arr[]=2)
  // 'json' = application/json
  bodyFormat: 'form',
  // Name of the parameter that identifies an existing event when editing it (to be confirmed by IT)
  eventIdField: 'event_id',
  timeoutMs: 15000,
};

class CrmError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function encode(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k + '[]', String(x)));
    else p.append(k, String(v));
  }
  return p.toString();
}

async function call(kind, params, opts = {}) {
  const cfg = opts.cfg || CFG;
  const fetchFn = opts.fetchFn || fetch;
  const env = opts.env || process.env;
  if (!env.RESPACIO_BASIC || !env.RESPACIO_API_KEY) throw new CrmError('config', 'Respacio credentials are not configured');
  const method = cfg.methods[kind];
  let url = cfg.urls[kind];
  const headers = {
    Authorization: 'Basic ' + env.RESPACIO_BASIC,
    'x-api-key': env.RESPACIO_API_KEY,
    Accept: 'application/json',
  };
  const init = { method, headers };
  if (method === 'GET') {
    const q = encode(params);
    if (q) url += (url.includes('?') ? '&' : '?') + q;
  } else if (cfg.bodyFormat === 'json') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(params);
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = encode(params);
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  init.signal = ac.signal;
  let res, text;
  try {
    res = await fetchFn(url, init);
    text = await res.text();
  } catch (e) {
    throw new CrmError(e && e.name === 'AbortError' ? 'timeout' : 'network', 'Could not reach Respacio');
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (!json || typeof json !== 'object') {
    const hint = res.status === 401 || res.status === 403 ? ' (credentials rejected)' : '';
    throw new CrmError('bad_response', 'Unexpected response from Respacio, HTTP ' + res.status + hint);
  }
  return { http: res.status, json };
}

const asId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

function diag(kind, http, json, list) {
  const msg = json && typeof json.message === 'string' ? json.message.slice(0, 120) : '';
  console.log('Respacio ' + kind + ': http=' + http + ' status=' + (json && json.status) + ' message=' + msg +
    ' keys=' + Object.keys(json || {}).join(',') + ' dataKeys=' + Object.keys((json && json.data) || {}).join(',') +
    ' list=' + (Array.isArray(list) ? list.length : 'none'));
}

async function searchProperties(q, opts) {
  const { http, json } = await call('properties', { reference_no: q }, opts);
  const list = json && json.data && json.data.property_list;
  diag('properties', http, json, list);
  if (json.status !== 'success' || !Array.isArray(list)) return [];
  return list
    .map((p) => ({ id: asId(p.id), reference_no: String(p.reference_no == null ? '' : p.reference_no), title: String(p.title || '') }))
    .filter((p) => p.id)
    .slice(0, 20);
}

async function searchContacts(q, opts) {
  const { http, json } = await call('contacts', { reference_no: q }, opts);
  const list = json && json.data && json.data.contact_list;
  diag('contacts', http, json, list);
  if (json.status !== 'success' || !Array.isArray(list)) return [];
  // Only what the app needs: no email or phone number is sent to the agent's phone.
  return list
    .map((c) => ({ id: asId(c.id), reference_no: String(c.reference_no == null ? '' : c.reference_no), name: String(c.name || '') }))
    .filter((c) => c.id)
    .slice(0, 20);
}

function linkedProps(v) {
  const ids = (Array.isArray(v.props) ? v.props : []).map((p) => asId(p && p.crmPropertyId)).filter(Boolean);
  return [...new Set(ids)];
}

const fmtDate = (d) => String(d || '').split('-').reverse().join('/');

// The CRM requires notes to create the event, so there is always a header line.
function buildNotes(v) {
  const lines = ['Viewing registered with the Prestige viewing log app. Date: ' + fmtDate(v.date) + '.'];
  if (v.client) lines.push('Client: ' + String(v.client).slice(0, 200));
  const props = (Array.isArray(v.props) ? v.props : [])
    .map((p) => [p.ref, p.property].filter(Boolean).join(' ').trim())
    .filter(Boolean);
  if (props.length) lines.push('Properties: ' + props.join('; '));
  if (v.rating) lines.push('Rating: ' + (Number(v.rating) | 0) + '/5');
  if (v.feedback) lines.push('Feedback: ' + String(v.feedback).slice(0, 2000));
  return lines.join('\n');
}

/*
 * Creates the "Viewing" event in the CRM (first time) or edits it (when an event_id is already stored),
 * and stores the result in the visit document under "crm". Only the owner of the visit can trigger it.
 */
async function syncVisit({ db, visitId, uid, email, callFn, now, cfg }) {
  const c = cfg || CFG;
  const call_ = callFn || ((kind, params) => call(kind, params, { cfg: c }));
  const clock = now || Date.now;
  const ref = db.collection('visits').doc(visitId);

  const gate = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { error: 'not-found' };
    const v = snap.data();
    if (v.agentUid !== uid) return { error: 'permission-denied' };
    const crm = v.crm || {};
    const ids = linkedProps(v);
    if (!ids.length) {
      tx.update(ref, { crm: { status: 'skipped', message: 'No CRM property selected', updatedAt: clock() } });
      return { skipped: true };
    }
    if (crm.status === 'syncing' && clock() - (crm.lockAt || 0) < 90000) return { busy: true };
    tx.update(ref, { crm: { ...crm, status: 'syncing', lockAt: clock() } });
    return { v, crm, ids };
  });
  if (gate.error) return { error: gate.error };
  if (gate.skipped) return { status: 'skipped' };
  if (gate.busy) return { status: 'busy' };

  const { v, crm, ids } = gate;
  const params = { user_email: email, property_arr: ids, notes: buildNotes(v) };
  const cid = asId(v.clientId);
  if (cid) params.contact_id = cid;
  if (crm.eventId) params[c.eventIdField] = crm.eventId;

  const fail = async (message) => {
    const msg = String(message || 'Respacio rejected the request').slice(0, 300);
    await ref.update({ crm: { status: 'error', eventId: crm.eventId || null, message: msg, updatedAt: clock() } });
    return { status: 'error', message: msg };
  };
  try {
    const { http, json } = await call_('event', params);
    console.log('Respacio event: http=' + http + ' status=' + (json && json.status) + ' message=' + String((json && json.message) || '').slice(0, 120) + ' event_id=' + (json && json.event_id));
    if (json.status === 'success') {
      const eventId = json.event_id != null && json.event_id !== '' ? Number(json.event_id) : crm.eventId || null;
      await ref.update({ crm: { status: 'ok', eventId, syncedAt: clock(), message: eventId ? '' : 'Respacio did not return an event id' } });
      return { status: 'ok', eventId };
    }
    return await fail(json.message);
  } catch (e) {
    return await fail(e && e.code === 'timeout' ? 'Respacio did not answer in time' : e && e.message);
  }
}

module.exports = { CFG, CrmError, encode, call, searchProperties, searchContacts, linkedProps, buildNotes, syncVisit };
