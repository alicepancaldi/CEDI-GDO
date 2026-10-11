// @ts-nocheck  (codice JavaScript puro, testato anche in Node)
// Funzione Supabase "ors": tramite verso OpenRouteService.
// La chiave ORS resta sul server (secret ORS_API_KEY) e non arriva mai al browser.
// Accetta solo utenti con login: il token viene verificato con Supabase Auth (utenteValido).
//
// Richieste (POST JSON):
//   { azione: "geocodifica", testo: "Via Emilia 1, Bologna" }
//   { azione: "inversa", lat: 44.49, lng: 11.34 }
//   { azione: "matrice", origini: [{lat,lng}], destinazioni: [{lat,lng}, ...] }
// Risposta: sempre HTTP 200 con { ok: true, dati } oppure { ok: false, errore, riprova? }

// Indirizzi HeiGIT (api.openrouteservice.org è in dismissione: quota ridotta e chiusura a novembre 2026).
// Il secondo indirizzo di ogni elenco è usato solo se il primo risponde 404/405/410 o non è raggiungibile.
const BASI_MATRICE = ["https://api.heigit.org/openrouteservice", "https://api.openrouteservice.org"];
const BASI_GEOCODIFICA = ["https://api.heigit.org/pelias/v1", "https://api.openrouteservice.org/geocode"];
const PROFILO = "driving-hgv"; // percorsi per mezzi pesanti
const MAX_PUNTI_MATRICE = 50;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function risposta(corpo) {
  return new Response(JSON.stringify(corpo), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
}

function coord(p, nome) {
  const lat = Number(p && p.lat), lng = Number(p && p.lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error("Coordinate non valide: " + nome);
  return [lng, lat];
}

async function chiamaOrs(url, init) {
  let r;
  try { r = await fetch(url, init); } catch (e) { const x = new Error("OpenRouteService non raggiungibile: " + (e && e.message)); x.alternativa = true; throw x; }
  if (r.status === 429) { const e = new Error("Limite di richieste OpenRouteService raggiunto"); e.riprova = true; throw e; }
  const testo = await r.text();
  let j = null;
  try { j = JSON.parse(testo); } catch (_) { /* risposta non JSON */ }
  if (!r.ok) {
    const msg = (j && j.error && (j.error.message || j.error)) || testo.slice(0, 200);
    const e = new Error("OpenRouteService " + r.status + ": " + (typeof msg === "string" ? msg : JSON.stringify(msg)));
    e.alternativa = r.status === 404 || r.status === 405 || r.status === 410;
    throw e;
  }
  return j;
}

/** Prova gli indirizzi in ordine; passa al successivo solo se quello corrente non esiste o non risponde. */
async function chiamaConRiserva(urls, init) {
  let ultimo;
  for (const u of urls) {
    try { return await chiamaOrs(u, init); } catch (e) { if (!e.alternativa) throw e; ultimo = e; }
  }
  throw ultimo;
}

function urlGeocodifica(percorso, chiave, parametri) {
  return BASI_GEOCODIFICA.map((b) => {
    const u = new URL(b + percorso);
    u.searchParams.set("api_key", chiave);
    Object.keys(parametri).forEach((k) => u.searchParams.set(k, parametri[k]));
    return u.toString();
  });
}

async function gestisci(b, chiave) {
  if (!chiave) throw new Error("Chiave ORS_API_KEY non configurata nei secret di Supabase");
  if (b.azione === "geocodifica") {
    const testo = String(b.testo || "").trim();
    if (!testo) throw new Error("Indirizzo vuoto");
    const j = await chiamaConRiserva(urlGeocodifica("/search", chiave, { text: testo, "boundary.country": "IT", size: "1", lang: "it" }),
      { method: "GET", headers: { Authorization: chiave, Accept: "application/json" } });
    const f = j && j.features && j.features[0];
    if (!f) return null;
    return {
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
      indirizzo: f.properties.label || testo,
      livello: f.properties.layer || "",           // address, street, locality...
      affidabilita: f.properties.confidence ?? null // 0..1
    };
  }
  if (b.azione === "inversa") {
    const [lng, lat] = coord(b, "punto");
    const j = await chiamaConRiserva(urlGeocodifica("/reverse", chiave, { "point.lat": String(lat), "point.lon": String(lng), size: "1", lang: "it" }),
      { method: "GET", headers: { Authorization: chiave, Accept: "application/json" } });
    const f = j && j.features && j.features[0];
    return { indirizzo: f ? f.properties.label : null };
  }
  if (b.azione === "matrice") {
    const o = Array.isArray(b.origini) ? b.origini : [], d = Array.isArray(b.destinazioni) ? b.destinazioni : [];
    if (!o.length || !d.length) throw new Error("Origini e destinazioni obbligatorie");
    if (o.length + d.length > MAX_PUNTI_MATRICE) throw new Error("Troppi punti in una richiesta (max " + MAX_PUNTI_MATRICE + ")");
    const locations = o.map((p, i) => coord(p, "origine " + i)).concat(d.map((p, i) => coord(p, "destinazione " + i)));
    const j = await chiamaConRiserva(BASI_MATRICE.map((b) => b + "/v2/matrix/" + PROFILO), {
      method: "POST",
      headers: { "Authorization": chiave, "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        locations,
        sources: o.map((_, i) => i),
        destinations: d.map((_, i) => o.length + i),
        metrics: ["distance", "duration"],
        units: "km",
      }),
    });
    if (!j || !Array.isArray(j.distances) || !Array.isArray(j.durations)) throw new Error("Risposta matrice non valida");
    return {
      km: j.distances.map((r) => r.map((x) => (x === null || x === undefined ? null : Number(x)))),
      minuti: j.durations.map((r) => r.map((x) => (x === null || x === undefined ? null : Number(x) / 60))),
    };
  }
  throw new Error("Azione sconosciuta");
}

/** Verifica che la richiesta venga da un utente con login valido (funziona con chiavi JWT nuove e legacy). */
async function utenteValido(req) {
  const auth = req.headers.get("Authorization") || "";
  if (!/^Bearer\s+\S+/.test(auth)) return false;
  const base = Deno.env.get("SUPABASE_URL");
  const apikey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
  if (!base) return false;
  const r = await fetch(base + "/auth/v1/user", { headers: { Authorization: auth, apikey } });
  if (!r.ok) return false;
  const u = await r.json().catch(() => null);
  return !!(u && u.id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return risposta({ ok: false, errore: "Usare POST" });
  try {
    if (!(await utenteValido(req))) return risposta({ ok: false, errore: "Accesso non autorizzato: effettuare di nuovo il login" });
    const corpo = await req.json();
    const dati = await gestisci(corpo || {}, Deno.env.get("ORS_API_KEY"));
    return risposta({ ok: true, dati });
  } catch (e) {
    return risposta({ ok: false, errore: e && e.message ? e.message : String(e), riprova: !!(e && e.riprova) });
  }
});
