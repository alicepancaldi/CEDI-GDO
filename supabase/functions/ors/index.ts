// Funzione Supabase "ors": tramite verso OpenRouteService.
// La chiave ORS resta sul server (secret ORS_API_KEY) e non arriva mai al browser.
// Accetta solo utenti con login (verifica JWT di Supabase attiva per default).
//
// Richieste (POST JSON):
//   { azione: "geocodifica", testo: "Via Emilia 1, Bologna" }
//   { azione: "inversa", lat: 44.49, lng: 11.34 }
//   { azione: "matrice", origini: [{lat,lng}], destinazioni: [{lat,lng}, ...] }
// Risposta: sempre HTTP 200 con { ok: true, dati } oppure { ok: false, errore, riprova? }

const ORS = "https://api.openrouteservice.org";
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
  const r = await fetch(url, init);
  if (r.status === 429) { const e = new Error("Limite di richieste OpenRouteService raggiunto"); e.riprova = true; throw e; }
  const testo = await r.text();
  let j = null;
  try { j = JSON.parse(testo); } catch (_) { /* risposta non JSON */ }
  if (!r.ok) {
    const msg = (j && j.error && (j.error.message || j.error)) || testo.slice(0, 200);
    throw new Error("OpenRouteService " + r.status + ": " + (typeof msg === "string" ? msg : JSON.stringify(msg)));
  }
  return j;
}

async function gestisci(b, chiave) {
  if (!chiave) throw new Error("Chiave ORS_API_KEY non configurata nei secret di Supabase");
  if (b.azione === "geocodifica") {
    const testo = String(b.testo || "").trim();
    if (!testo) throw new Error("Indirizzo vuoto");
    const u = new URL(ORS + "/geocode/search");
    u.searchParams.set("api_key", chiave);
    u.searchParams.set("text", testo);
    u.searchParams.set("boundary.country", "IT");
    u.searchParams.set("size", "1");
    u.searchParams.set("lang", "it");
    const j = await chiamaOrs(u.toString(), { method: "GET" });
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
    const u = new URL(ORS + "/geocode/reverse");
    u.searchParams.set("api_key", chiave);
    u.searchParams.set("point.lat", String(lat));
    u.searchParams.set("point.lon", String(lng));
    u.searchParams.set("size", "1");
    u.searchParams.set("lang", "it");
    const j = await chiamaOrs(u.toString(), { method: "GET" });
    const f = j && j.features && j.features[0];
    return { indirizzo: f ? f.properties.label : null };
  }
  if (b.azione === "matrice") {
    const o = Array.isArray(b.origini) ? b.origini : [], d = Array.isArray(b.destinazioni) ? b.destinazioni : [];
    if (!o.length || !d.length) throw new Error("Origini e destinazioni obbligatorie");
    if (o.length + d.length > MAX_PUNTI_MATRICE) throw new Error("Troppi punti in una richiesta (max " + MAX_PUNTI_MATRICE + ")");
    const locations = o.map((p, i) => coord(p, "origine " + i)).concat(d.map((p, i) => coord(p, "destinazione " + i)));
    const j = await chiamaOrs(ORS + "/v2/matrix/" + PROFILO, {
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return risposta({ ok: false, errore: "Usare POST" });
  try {
    const corpo = await req.json();
    const dati = await gestisci(corpo || {}, Deno.env.get("ORS_API_KEY"));
    return risposta({ ok: true, dati });
  } catch (e) {
    return risposta({ ok: false, errore: e && e.message ? e.message : String(e), riprova: !!(e && e.riprova) });
  }
});
