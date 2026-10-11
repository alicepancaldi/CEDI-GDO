// Simulatori per i test: OpenRouteService finto, funzione Supabase "ors" reale, client Supabase in memoria.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LUOGHI = {
  'Via Emilia 1, Bologna': [44.4949, 11.3426, 'address'],
  'Via Modena 10, Modena': [44.6471, 10.9252, 'address'],
  'Via Reggio 5, Reggio Emilia': [44.6989, 10.6297, 'address'],
  'Via Parma 3, Parma': [44.8015, 10.3279, 'address'],
  'Via Ferrara 7, Ferrara': [44.8381, 11.6198, 'address'],
  'Via Imola 2, Imola': [44.3533, 11.7141, 'address'],
  'Via Forlì 9, Forlì': [44.2227, 12.0407, 'address'],
  'Via Ravenna 4, Ravenna': [44.4184, 12.2035, 'address'],
  'Via Rimini 8, Rimini': [44.0678, 12.5695, 'address'],
  'Via Cesena 6, Cesena': [44.1391, 12.2431, 'address'],
  'Interporto, Bentivoglio': [44.6370, 11.4070, 'venue'],
  'Via Modena 10, 41121 Modena (MO)': [44.6471, 10.9252, 'address'],
  'Via Carpi 1, 41012 Carpi (MO)': [44.7842, 10.8851, 'address'],
  'Via Carpi 1, Carpi (MO)': [44.7842, 10.8851, 'address'],
  'Via Modena 10, Modena (MO)': [44.6471, 10.9252, 'address'],
  'Via San Nicola 7, Torre a Mare (BA)': [40.9044, 8.8720, 'address'],
  'Torre a Mare (BA)': [41.0866, 16.9967, 'locality'],
  'Via Sassuolo 2, 41049 Sassuolo (MO)': [44.5446, 10.7836, 'street'],
  'Corso Vignola, 41058 Vignola (MO)': [44.4810, 11.0012, 'locality'],
  'Castel San Pietro Terme': [44.3976, 11.5876, 'locality'],
  'Via San Lazzaro 1, San Lazzaro di Savena': [44.4706, 11.4084, 'address']
};

function hav(a, b) {
  const R = 6371, t = Math.PI / 180;
  const dl = (b[1] - a[1]) * t, dg = (b[0] - a[0]) * t;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a[1] * t) * Math.cos(b[1] * t) * Math.sin(dg / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Server ORS finto: risponde come l'API reale (formati GeoJSON / matrix). */
function creaOrsFinto(opz = {}) {
  const st = { geocode: 0, reverse: 0, matrix: 0, ultimaMatrice: null, limiteUnaVolta: !!opz.limiteUnaVolta, irraggiungibili: opz.irraggiungibili || [] };
  async function fetchFinto(url, init = {}) {
    const u = new URL(url);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.pathname === '/auth/v1/user') {
      st.auth = (st.auth || 0) + 1;
      const h = init.headers || {};
      return (h.Authorization === 'Bearer jwt-valido' && h.apikey === 'anon') ? json(200, { id: 'u1', email: 'alice@esempio.it' }) : json(401, { msg: 'invalid JWT' });
    }
    st.host = u.host; st.hosts = (st.hosts || []).concat(u.host);
    if (opz.nuoviAssenti && u.host === 'api.heigit.org') return json(404, { error: 'not found' });
    const percorso = { 'api.heigit.org/pelias/v1/search': 'GS', 'api.openrouteservice.org/geocode/search': 'GS',
      'api.heigit.org/pelias/v1/reverse': 'GR', 'api.openrouteservice.org/geocode/reverse': 'GR',
      'api.heigit.org/openrouteservice/v2/matrix/driving-hgv': 'M', 'api.openrouteservice.org/v2/matrix/driving-hgv': 'M' }[u.host + u.pathname];
    if (st.limiteUnaVolta) { st.limiteUnaVolta = false; return json(429, { error: 'Rate limit' }); }
    if (percorso === 'GS') {
      st.geocode++;
      if (u.searchParams.get('api_key') !== 'CHIAVE-TEST') return json(403, { error: 'Access to this API has been disallowed' });
      if (u.searchParams.get('boundary.country') !== 'IT') return json(400, { error: 'paese mancante' });
      const k = LUOGHI[u.searchParams.get('text')];
      return json(200, { type: 'FeatureCollection', features: k ? [{ geometry: { type: 'Point', coordinates: [k[1], k[0]] }, properties: { label: u.searchParams.get('text') + ', Italia', layer: k[2], confidence: k[2] === 'address' ? 1 : 0.6 } }] : [] });
    }
    if (percorso === 'GR') {
      st.reverse++;
      return json(200, { features: [{ properties: { label: 'Località simulata ' + Number(u.searchParams.get('point.lat')).toFixed(3) } }] });
    }
    if (percorso === 'M') {
      st.matrix++;
      if (init.headers.Authorization !== 'CHIAVE-TEST') return json(403, { error: { message: 'Access denied' } });
      const b = JSON.parse(init.body);
      st.ultimaMatrice = b;
      if (b.locations.length > 50) return json(400, { error: { code: 6004, message: 'Request parameters exceed the server configuration limits' } });
      if (b.units !== 'km') return json(400, { error: 'units' });
      const out = (f) => b.sources.map(i => b.destinations.map(j => {
        const a = b.locations[i], d = b.locations[j];
        if (st.irraggiungibili.some(p => Math.abs(p[0] - d[1]) < 1e-6 && Math.abs(p[1] - d[0]) < 1e-6)) return null;
        return f(hav(a, d) * 1.3);
      }));
      return json(200, { distances: out(km => Math.round(km * 100) / 100), durations: out(km => Math.round(km / 65 * 3600 * 10) / 10), metadata: {} });
    }
    return json(404, { error: 'not found' });
  }
  return { st, fetch: fetchFinto };
}

/** Carica la vera funzione Supabase (index.ts) e restituisce il suo gestore HTTP. */
function caricaFunzioneOrs(fetchFn, chiave = 'CHIAVE-TEST') {
  let gestore = null;
  const ctx = {
    Deno: { env: { get: k => ({ ORS_API_KEY: chiave, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon' })[k] || undefined }, serve: h => { gestore = h; } },
    fetch: fetchFn, Response, Request, URL, JSON, Number, String, Array, Math, Error, isFinite, console
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'ors', 'index.ts'), 'utf8'), ctx, { filename: 'ors/index.ts' });
  return gestore;
}

/** Client Supabase in memoria con le stesse regole di schema.sql. */
function creaSupabaseFinto(gestoreOrs, opz = {}) {
  const sedi = ['ATTUALE', 'OPZ1', 'OPZ2', 'OPZ3', 'OTTIMO'];
  const nomi = { ATTUALE: 'CEDI attuale', OPZ1: 'Opzione 1', OPZ2: 'Opzione 2', OPZ3: 'Opzione 3', OTTIMO: 'Punto di ottimo' };
  const db = {
    parametri: [{ id: 1, euro_km: 1.3, km_fatturati: 'AR', capacita_pallet: 33, costo_fisso_viaggio: 0, settimane_anno: 52, giorni_settimana: 6 }],
    sedi: sedi.map(c => ({ codice: c, nome: nomi[c], indirizzo: '', lat: null, lng: null, capacita_mezzo: null, geocodifica: '' })),
    punti_vendita: [], distanze: [], carichi: [], reparti: []
  };
  const pk = { parametri: ['id'], sedi: ['codice'], punti_vendita: ['codice'], distanze: ['sede', 'pv'], carichi: ['pv', 'data', 'reparto'], reparti: ['reparto'] };
  const revocati = { sedi: ['insert', 'delete'], parametri: ['insert', 'delete'] };
  const stats = { select: 0, upsert: 0, update: 0, delete: 0, invoke: 0, maxRange: 0 };
  const utenti = { 'alice@esempio.it': 'segreta' };
  let sessione = opz.sessione || null;
  const ascoltatori = [];

  function verifica(t, r) {
    const e = m => { throw { message: m }; };
    if (t === 'parametri') {
      if (!(r.euro_km > 0)) e('violates check constraint parametri_euro_km_check');
      if (!['AR', 'A'].includes(r.km_fatturati)) e('violates check constraint km_fatturati');
    }
    if (t === 'punti_vendita') {
      ['codice', 'indirizzo', 'lat', 'lng'].forEach(c => { if (r[c] === null || r[c] === undefined || r[c] === '') e('null value in column "' + c + '" violates not-null constraint'); });
      if ((r.pallet_settimana != null && !(r.pallet_settimana > 0)) || (r.consegne_settimana != null && !(r.consegne_settimana > 0))) e('violates check constraint');
      if (typeof r.lat !== 'number' || !isFinite(r.lat)) e('lat non numerica');
    }
    if (t === 'distanze') {
      if (!sedi.includes(r.sede)) e('violates foreign key constraint distanze_sede_fkey');
      if (!db.punti_vendita.some(p => p.codice === r.pv)) e('violates foreign key constraint distanze_pv_fkey');
      if (!(r.km >= 0) || !(r.minuti >= 0)) e('violates check constraint distanze_km_check');
      if (!r.chiave) e('null chiave');
    }
    if (t === 'carichi') {
      if (!db.punti_vendita.some(p => p.codice === r.pv)) e('violates foreign key constraint carichi_pv_fkey');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.data)) e('invalid input syntax for type date');
      if (!(r.colli >= 0)) e('violates check constraint carichi_colli_check');
    }
    if (t === 'reparti' && r.colli_per_pallet != null && !(r.colli_per_pallet > 0)) e('violates check constraint reparti');
    if (t === 'parametri' && r.giorni_settimana != null && !(r.giorni_settimana >= 1 && r.giorni_settimana <= 7)) e('giorni_settimana check');
    if (t === 'sedi' && r.capacita_mezzo !== null && r.capacita_mezzo !== undefined && !(r.capacita_mezzo > 0)) e('capacita check');
    Object.values(r).forEach(v => { if (v !== null && typeof v === 'object') e('valore non scalare'); if (typeof v === 'number' && !isFinite(v)) e('numero non finito'); });
  }
  const chiave = (t, r) => pk[t].map(k => String(r[k])).join('|');
  const clona = x => JSON.parse(JSON.stringify(x));

  function query(t) {
    let op = 'select', filtri = [], ordini = [], rng = null, valori = null, conflitto = null, ritorna = false, ignora = false;
    const q = {
      select() { if (op !== 'select') ritorna = true; return q; },
      order(c, o) { ordini.push([c, o && o.ascending === false ? -1 : 1]); return q; },
      range(a, b) { rng = [a, b]; stats.maxRange = Math.max(stats.maxRange, b - a + 1); return q; },
      eq(c, v) { filtri.push(r => String(r[c]) === String(v)); return q; },
      gte(c, v) { filtri.push(r => String(r[c]) >= String(v)); return q; },
      in(c, vs) { const s = vs.map(String); filtri.push(r => s.includes(String(r[c]))); return q; },
      match(o) { Object.keys(o).forEach(k => q.eq(k, o[k])); return q; },
      upsert(righe, o) { op = 'upsert'; valori = righe; conflitto = o && o.onConflict; ignora = !!(o && o.ignoreDuplicates); return q; },
      update(v) { op = 'update'; valori = v; return q; },
      delete() { op = 'delete'; return q; },
      then(ok, ko) { return Promise.resolve().then(esegui).then(ok, ko); }
    };
    function esegui() {
      if (!sessione) return { data: null, error: { message: 'permission denied (anon)' } };
      try {
        if (op === 'select') {
          stats.select++;
          let r = db[t].filter(x => filtri.every(f => f(x)));
          r.sort((a, b) => { for (const [c, d] of ordini) { if (a[c] < b[c]) return -d; if (a[c] > b[c]) return d; } return 0; });
          const tot = r.length;
          if (rng) r = r.slice(rng[0], Math.min(rng[1] + 1, rng[0] + 1000));
          else r = r.slice(0, 1000); // limite PostgREST di default
          return { data: clona(r), error: null, count: tot };
        }
        if (op === 'upsert') {
          stats.upsert++;
          if ((revocati[t] || []).includes('insert')) throw { message: 'permission denied for table ' + t };
          if (conflitto && conflitto.replace(/\s/g, '') !== pk[t].join(',')) throw { message: 'there is no unique constraint matching ON CONFLICT ' + conflitto };
          const nuove = clona(valori);
          const viste = new Set();
          nuove.forEach(r => { const k = chiave(t, r); if (viste.has(k)) throw { message: 'ON CONFLICT DO UPDATE command cannot affect row a second time' }; viste.add(k); verifica(t, r); });
          nuove.forEach(r => {
            const i = db[t].findIndex(x => chiave(t, x) === chiave(t, r));
            if (i >= 0) { if (!ignora) db[t][i] = Object.assign(db[t][i], r); } else db[t].push(Object.assign(t === 'reparti' ? { colli_per_pallet: null } : {}, r));
          });
          return { data: null, error: null };
        }
        if (op === 'update') {
          stats.update++;
          const righe = db[t].filter(x => filtri.every(f => f(x)));
          righe.forEach(r => verifica(t, Object.assign({}, r, valori)));
          righe.forEach(r => Object.assign(r, clona(valori)));
          return { data: ritorna ? clona(righe) : null, error: null };
        }
        if (op === 'delete') {
          stats.delete++;
          if ((revocati[t] || []).includes('delete')) throw { message: 'permission denied for table ' + t };
          if (!filtri.length) throw { message: 'DELETE requires a WHERE clause' };
          const via = db[t].filter(x => filtri.every(f => f(x)));
          db[t] = db[t].filter(x => !via.includes(x));
          if (t === 'punti_vendita') { const c = via.map(p => p.codice); db.distanze = db.distanze.filter(d => !c.includes(d.pv)); db.carichi = db.carichi.filter(d => !c.includes(d.pv)); }
          return { data: null, error: null };
        }
      } catch (e) { return { data: null, error: { message: e.message || String(e) } }; }
    }
    return q;
  }

  const client = {
    from: query,
    auth: {
      async getSession() { return { data: { session: sessione }, error: null }; },
      async signInWithPassword({ email, password }) {
        if (utenti[email] !== password) return { data: { session: null }, error: { message: 'Invalid login credentials' } };
        sessione = { user: { email }, access_token: 'jwt-valido' }; ascoltatori.forEach(f => f('SIGNED_IN', sessione));
        return { data: { session: sessione }, error: null };
      },
      async signOut() { sessione = null; ascoltatori.forEach(f => f('SIGNED_OUT', null)); return { error: null }; },
      onAuthStateChange(f) { ascoltatori.push(f); return { data: { subscription: { unsubscribe() {} } } }; }
    },
    functions: {
      async invoke(nome, { body }) {
        stats.invoke++;
        if (nome !== 'ors') return { data: null, error: { message: 'Function not found' } };
        if (!sessione) return { data: null, error: { message: 'Edge Function returned a non-2xx status code' } };
        const res = await gestoreOrs(new Request('https://x.supabase.co/functions/v1/ors', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessione.access_token } }));
        return { data: await res.json(), error: null };
      }
    }
  };
  return { client, db, stats };
}

module.exports = { LUOGHI, hav, creaOrsFinto, caricaFunzioneOrs, creaSupabaseFinto };
