// Test della funzione Supabase "ors" (codice reale) contro un server OpenRouteService simulato
const test = require('node:test');
const assert = require('node:assert');
const { creaOrsFinto, caricaFunzioneOrs } = require('./helpers');

async function chiama(gestore, body, metodo = 'POST', token = 'jwt-valido') {
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  const r = await gestore(new Request('https://x/functions/v1/ors', { method: metodo, headers, body: metodo === 'POST' ? JSON.stringify(body) : undefined }));
  return { status: r.status, cors: r.headers.get('Access-Control-Allow-Origin'), corpo: metodo === 'OPTIONS' ? await r.text() : await r.json() };
}

test('CORS e metodo', async () => {
  const g = caricaFunzioneOrs(creaOrsFinto().fetch);
  const o = await chiama(g, null, 'OPTIONS');
  assert.strictEqual(o.status, 200); assert.strictEqual(o.cors, '*');
});

test('geocodifica: trovato, livello di precisione, non trovato', async () => {
  const ors = creaOrsFinto(); const g = caricaFunzioneOrs(ors.fetch);
  let r = await chiama(g, { azione: 'geocodifica', testo: 'Via Emilia 1, Bologna' });
  assert.deepStrictEqual(r.corpo, { ok: true, dati: { lat: 44.4949, lng: 11.3426, indirizzo: 'Via Emilia 1, Bologna, Italia', livello: 'address', affidabilita: 1 } });
  r = await chiama(g, { azione: 'geocodifica', testo: 'Castel San Pietro Terme' });
  assert.strictEqual(r.corpo.dati.livello, 'locality');
  r = await chiama(g, { azione: 'geocodifica', testo: 'Via che non esiste' });
  assert.deepStrictEqual(r.corpo, { ok: true, dati: null });
  r = await chiama(g, { azione: 'geocodifica', testo: '  ' });
  assert.strictEqual(r.corpo.ok, false); assert.match(r.corpo.errore, /vuoto/);
});

test('matrice: formato richiesta ORS (lon,lat, indici, km) e risposta', async () => {
  const ors = creaOrsFinto({ irraggiungibili: [[44.0678, 12.5695]] }); const g = caricaFunzioneOrs(ors.fetch);
  const r = await chiama(g, { azione: 'matrice', origini: [{ lat: 44.4949, lng: 11.3426 }], destinazioni: [{ lat: 44.6471, lng: 10.9252 }, { lat: 44.0678, lng: 12.5695 }] });
  assert.strictEqual(r.corpo.ok, true);
  const b = ors.st.ultimaMatrice;
  assert.deepStrictEqual(b.locations[0], [11.3426, 44.4949], 'longitudine prima');
  assert.deepStrictEqual(b.sources, [0]); assert.deepStrictEqual(b.destinations, [1, 2]);
  assert.strictEqual(b.units, 'km'); assert.deepStrictEqual(b.metrics, ['distance', 'duration']);
  assert.ok(r.corpo.dati.km[0][0] > 40 && r.corpo.dati.km[0][0] < 50, 'Bologna-Modena ~45 km');
  assert.ok(r.corpo.dati.minuti[0][0] > 30 && r.corpo.dati.minuti[0][0] < 60, 'minuti, non secondi');
  assert.strictEqual(r.corpo.dati.km[0][1], null); assert.strictEqual(r.corpo.dati.minuti[0][1], null);
});

test('matrice: limiti e coordinate non valide', async () => {
  const g = caricaFunzioneOrs(creaOrsFinto().fetch);
  const molti = Array.from({ length: 50 }, () => ({ lat: 44, lng: 11 }));
  let r = await chiama(g, { azione: 'matrice', origini: [{ lat: 44, lng: 11 }], destinazioni: molti });
  assert.match(r.corpo.errore, /max 50/);
  r = await chiama(g, { azione: 'matrice', origini: [{ lat: 'x', lng: 11 }], destinazioni: [{ lat: 44, lng: 11 }] });
  assert.match(r.corpo.errore, /Coordinate non valide/);
  r = await chiama(g, { azione: 'matrice', origini: [], destinazioni: [] });
  assert.match(r.corpo.errore, /obbligatorie/);
});

test('limite di richieste ORS -> riprova, chiave errata o mancante -> errore chiaro', async () => {
  let g = caricaFunzioneOrs(creaOrsFinto({ limiteUnaVolta: true }).fetch);
  let r = await chiama(g, { azione: 'geocodifica', testo: 'Via Emilia 1, Bologna' });
  assert.deepStrictEqual([r.corpo.ok, r.corpo.riprova], [false, true]);
  g = caricaFunzioneOrs(creaOrsFinto().fetch, 'SBAGLIATA');
  r = await chiama(g, { azione: 'matrice', origini: [{ lat: 44, lng: 11 }], destinazioni: [{ lat: 44.1, lng: 11 }] });
  assert.match(r.corpo.errore, /OpenRouteService 403: Access denied/);
  g = caricaFunzioneOrs(creaOrsFinto().fetch, null);
  r = await chiama(g, { azione: 'geocodifica', testo: 'x' });
  assert.match(r.corpo.errore, /ORS_API_KEY non configurata/);
  r = await chiama(g, { azione: 'boh' });
  assert.strictEqual(r.status, 200);
});

test('inversa', async () => {
  const g = caricaFunzioneOrs(creaOrsFinto().fetch);
  const r = await chiama(g, { azione: 'inversa', lat: 44.5, lng: 11.3 });
  assert.match(r.corpo.dati.indirizzo, /Località simulata 44.500/);
});

test('accesso: token mancante o non valido rifiutato, nessuna chiamata a ORS', async () => {
  const ors = creaOrsFinto(); const g = caricaFunzioneOrs(ors.fetch);
  let r = await chiama(g, { azione: 'geocodifica', testo: 'Via Emilia 1, Bologna' }, 'POST', null);
  assert.match(r.corpo.errore, /Accesso non autorizzato/);
  r = await chiama(g, { azione: 'geocodifica', testo: 'Via Emilia 1, Bologna' }, 'POST', 'falso');
  assert.match(r.corpo.errore, /Accesso non autorizzato/);
  assert.strictEqual(ors.st.geocode, 0);
});
