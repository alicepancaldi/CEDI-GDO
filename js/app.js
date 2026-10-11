/* Simulatore rilocalizzazione CEDI — interfaccia e accesso ai dati (Supabase + funzione "ors") */
(function () {
  'use strict';
  var C = window.Calcolo;
  var CFG = window.CONFIG || {};
  var PAUSA_MATRICE_MS = CFG.PAUSA_MATRICE_MS != null ? CFG.PAUSA_MATRICE_MS : 1600;       // ORS: 40 richieste/minuto
  var PAUSA_GEOCODIFICA_MS = CFG.PAUSA_GEOCODIFICA_MS != null ? CFG.PAUSA_GEOCODIFICA_MS : 700; // ORS: 100 richieste/minuto
  var PAUSA_LIMITE_MS = CFG.PAUSA_LIMITE_MS != null ? CFG.PAUSA_LIMITE_MS : 20000;
  var BLOCCO_MATRICE = 45;   // destinazioni per richiesta (max 50 punti totali)
  var BLOCCO_DB = 500;

  var sb = null;
  var S = { P: null, sedi: {}, pv: [], dist: [], carichi: [], reparti: {}, vol: null, viaggi: [], tariffe: [], gasolio: {}, gasolioOk: true, ultimiErroriDist: [], importPronto: null };
  function conViaggi() { return S.viaggi.length > 0; }
  function mappaPV() { var m = {}; S.pv.forEach(function (p) { m[p.codice] = p; }); return m; }
  function ricalcoloViaggi() { return C.ricalcolaViaggi(S.viaggi, S.sedi, S.dist, mappaPV(), S.P, S.tariffe); }

  /* ============================ utilità ============================ */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(x, dec) { return x == null || isNaN(x) ? '—' : Number(x).toLocaleString('it-IT', { minimumFractionDigits: dec, maximumFractionDigits: dec }); }
  function eur(x, dec) { return x == null ? '—' : fmt(x, dec == null ? 0 : dec) + ' €'; }
  function segno(x, dec, suff) {
    if (x == null || isNaN(x)) return '—';
    var r = Math.round(x * Math.pow(10, dec)) / Math.pow(10, dec);
    return '<span class="' + (r > 0 ? 'pos' : r < 0 ? 'neg' : '') + '">' + (r > 0 ? '+' : '') + fmt(r, dec) + (suff || '') + '</span>';
  }
  function pausa(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function msg(testo, tipo) { $('msg').innerHTML = testo ? '<div class="alert ' + (tipo || 'info') + '">' + testo + '</div>' : ''; }
  function errore(e) { msg(esc(e && e.message ? e.message : e), 'err'); if (window.console) console.warn(e); }
  function occupato(on) { Array.prototype.forEach.call(document.querySelectorAll('button.btn, input[type=file]'), function (b) { b.disabled = on; }); }
  function esegui(fn, testo) {
    occupato(true); msg(testo || 'Elaborazione in corso…', 'info');
    return Promise.resolve().then(fn).then(function (x) { occupato(false); return x; }, function (e) { occupato(false); errore(e); throw e; });
  }
  function scarica(nome, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = nome;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) { /* niente */ } }, 2000);
  }
  function coordTesto(p) { return p && p.lat != null ? Number(p.lat).toFixed(6) + ', ' + Number(p.lng).toFixed(6) : ''; }
  function vicine(a, b) { return a && b && b.lat != null && Math.abs(a.lat - b.lat) < 5e-7 && Math.abs(a.lng - b.lng) < 5e-7; }
  function nomeSede(c) { return c === 'ATTUALE' ? 'Attuale' : c === 'OTTIMO' ? 'Ottimo' : c.replace('OPZ', 'Opzione '); }

  var PRECISIONE = {
    address: ['indirizzo esatto', 'ok'], venue: ['indirizzo esatto', 'ok'], manuale: ['coordinate inserite a mano', 'ok'],
    calcolato: ['punto calcolato', 'ok'], street: ['via trovata, numero civico no', 'ok'],
    neighbourhood: ['solo quartiere: verificare', 'warn'], postalcode: ['solo CAP: verificare', 'warn'],
    locality: ['solo comune: verificare', 'warn'], localadmin: ['solo comune: verificare', 'warn'],
    borough: ['solo frazione: verificare', 'warn'], fuori_comune: ['via trovata fuori comune: usato il centro del comune, verificare', 'warn'],
    provincia_errata: ['trovato in un\'altra provincia: inserire le coordinate', 'err'], county: ['solo provincia: da correggere', 'err'],
    macrocounty: ['solo provincia: da correggere', 'err'], region: ['solo regione: da correggere', 'err'], country: ['solo nazione: da correggere', 'err']
  };
  function precisione(g) { return PRECISIONE[g] ? { testo: PRECISIONE[g][0], livello: PRECISIONE[g][1] } : { testo: g ? 'precisione: ' + g : 'precisione non indicata', livello: g ? 'warn' : 'ok' }; }

  /* ============================ database ============================ */
  function errDb(e) { return new Error('Database: ' + (e && (e.message || e.details) ? (e.message || e.details) : e)); }

  async function leggiTutto(tabella, ordini) {
    var out = [], da = 0, N = 1000;
    for (;;) {
      var q = sb.from(tabella).select('*');
      ordini.forEach(function (o) { q = q.order(o, { ascending: true }); });
      var r = await q.range(da, da + N - 1);
      if (r.error) throw errDb(r.error);
      out = out.concat(r.data || []);
      if (!r.data || r.data.length < N) break;
      da += N;
    }
    return out;
  }
  async function upsert(tabella, righe, conflitto, soloNuove) {
    for (var i = 0; i < righe.length; i += BLOCCO_DB) {
      var r = await sb.from(tabella).upsert(righe.slice(i, i + BLOCCO_DB), { onConflict: conflitto, ignoreDuplicates: !!soloNuove });
      if (r.error) throw errDb(r.error);
    }
  }
  async function aggiorna(tabella, campo, valore, valori) {
    var r = await sb.from(tabella).update(valori).eq(campo, valore).select();
    if (r.error) throw errDb(r.error);
    if (!r.data || !r.data.length) throw new Error('Nessuna riga aggiornata in "' + tabella + '": verificare che schema.sql sia stato eseguito.');
  }
  async function elimina(tabella, campo, valori) {
    if (!valori.length) return;
    var r = await sb.from(tabella).delete().in(campo, valori);
    if (r.error) throw errDb(r.error);
  }

  function daDbPV(r) {
    return { codice: String(r.codice), nome: r.nome || '', indirizzo: r.indirizzo || '', lat: Number(r.lat), lng: Number(r.lng),
      pallet: r.pallet_settimana == null ? null : Number(r.pallet_settimana), consegne: r.consegne_settimana == null ? null : Number(r.consegne_settimana),
      geocodifica: r.geocodifica || '', carico: null };
  }
  function aDbPV(p) {
    return { codice: p.codice, nome: p.nome, indirizzo: p.indirizzo, lat: p.lat, lng: p.lng, pallet_settimana: p.pallet,
      consegne_settimana: p.consegne, geocodifica: p.geocodifica || '', aggiornato_il: new Date().toISOString() };
  }
  function ordinaPV() { S.pv.sort(function (a, b) { return a.codice.localeCompare(b.codice, 'it', { numeric: true }); }); }

  /** Converte i carichi giornalieri in volumi (pallet) e li collega ai PV. */
  function ricalcolaVolumi() {
    var fattori = {};
    Object.keys(S.reparti).forEach(function (k) { fattori[k] = S.reparti[k]; });
    S.vol = S.carichi.length ? C.volumi(S.carichi, fattori, S.P.giorni_settimana) : null;
    var conCarichi = {};
    S.carichi.forEach(function (c) { conCarichi[c.pv] = true; });
    S.pv.forEach(function (p) {
      p.haCarichi = !!conCarichi[p.codice];
      p.carico = S.vol && S.vol.perPV[p.codice] ? S.vol.perPV[p.codice] : null;
    });
  }

  async function caricaDati() {
    var r = await Promise.all([leggiTutto('parametri', ['id']), leggiTutto('sedi', ['codice']), leggiTutto('punti_vendita', ['codice']), leggiTutto('distanze', ['pv', 'sede']),
      leggiTutto('carichi', ['pv', 'data', 'reparto']), leggiTutto('reparti', ['reparto']),
      leggiTutto('viaggi', ['id']), leggiTutto('viaggi_clienti', ['viaggio', 'pv']), leggiTutto('tariffe', ['anno', 'mezzo', 'km_da'])]);
    if (!r[0].length) throw new Error('Tabella "parametri" vuota: eseguire supabase/schema.sql.');
    var p = r[0][0];
    S.P = { euro_km: Number(p.euro_km), km_fatturati: p.km_fatturati, capacita_pallet: Number(p.capacita_pallet), costo_fisso_viaggio: Number(p.costo_fisso_viaggio),
      settimane_anno: Number(p.settimane_anno), giorni_settimana: p.giorni_settimana == null ? 6 : Number(p.giorni_settimana),
      anno_tariffa: p.anno_tariffa == null ? null : Number(p.anno_tariffa) };
    ['gas_rif', 'gas_quota', 'gas_franchigia', 'consumo_motrice', 'consumo_bilico', 'co2_kg_l'].forEach(function (k) { if (p[k] != null) S.P[k] = Number(p[k]); });
    S.gasolio = {}; S.gasolioOk = true;
    try { (await leggiTutto('gasolio', ['mese'])).forEach(function (g) { S.gasolio[g.mese] = Number(g.prezzo); }); }
    catch (e) { S.gasolioOk = false; } // tabella non ancora creata (schema.sql versione 4)
    S.sedi = {};
    r[1].forEach(function (s) {
      S.sedi[s.codice] = { codice: s.codice, nome: s.nome, indirizzo: s.indirizzo || '', lat: s.lat == null ? null : Number(s.lat), lng: s.lng == null ? null : Number(s.lng),
        capacita: s.capacita_mezzo == null ? null : Number(s.capacita_mezzo), geocodifica: s.geocodifica || '' };
    });
    C.CODICI_SEDI.forEach(function (c) { if (!S.sedi[c]) throw new Error('Sede ' + c + ' mancante: eseguire supabase/schema.sql.'); });
    S.pv = r[2].map(daDbPV); ordinaPV();
    // perimetro: i PV in Campania restano fuori da tutti i calcoli e le estrazioni (anche se presenti nel database)
    var fuori = {};
    S.fuoriPerimetro = S.pv.filter(function (p) { if (C.pvFuoriPerimetro(p)) { fuori[p.codice] = true; return true; } return false; });
    S.pv = S.pv.filter(function (p) { return !fuori[p.codice]; });
    S.dist = r[3].map(function (d) { return { sede: d.sede, pv: String(d.pv), km: Number(d.km), minuti: Number(d.minuti), chiave: d.chiave }; }).filter(function (d) { return !fuori[d.pv]; });
    S.carichi = r[4].map(function (c) { return { pv: String(c.pv), data: String(c.data).slice(0, 10), reparto: c.reparto, colli: Number(c.colli) }; }).filter(function (c) { return !fuori[c.pv]; });
    S.reparti = {};
    r[5].forEach(function (x) { S.reparti[x.reparto] = x.colli_per_pallet == null ? null : Number(x.colli_per_pallet); });
    S.carichi.forEach(function (c) { if (!(c.reparto in S.reparti)) S.reparti[c.reparto] = null; });
    ricalcolaVolumi();
    var perViaggio = {};
    S.viaggiConFuori = {};
    r[7].forEach(function (c) {
      if (fuori[String(c.pv)]) { S.viaggiConFuori[c.viaggio] = true; return; }
      (perViaggio[c.viaggio] = perViaggio[c.viaggio] || []).push({ pv: String(c.pv), occ: Number(c.occ), colli: Number(c.colli), kmZona: c.km_zona == null ? null : Number(c.km_zona) });
    });
    S.viaggi = r[6].map(function (v) {
      return { id: v.id, data: String(v.data).slice(0, 10), giro: v.giro || '', vettore: v.vettore || '', mezzo: v.mezzo || '',
        capPallet: v.cap_pallet == null ? null : Number(v.cap_pallet), capRoll: v.cap_roll == null ? null : Number(v.cap_roll), clienti: perViaggio[v.id] || [] };
    });
    S.viaggiFuori = S.viaggi.filter(function (v) { return !v.clienti.length; }).length;
    S.viaggi = S.viaggi.filter(function (v) { return v.clienti.length; });
    S.tariffe = r[8].map(function (t) {
      return { id: t.id, anno: Number(t.anno), mezzo: t.mezzo || '*', km_da: Number(t.km_da), km_a: t.km_a == null ? null : Number(t.km_a), euro_km: Number(t.euro_km), euro_fisso: Number(t.euro_fisso) };
    });
  }

  /* ============================ OpenRouteService (via funzione Supabase) ============================ */
  async function ors(azione, corpo) {
    for (var t = 0; ; t++) {
      var r = await sb.functions.invoke('ors', { body: Object.assign({ azione: azione }, corpo) });
      if (r.error) throw new Error('Servizio distanze non raggiungibile (funzione "ors" pubblicata?): ' + (r.error.message || r.error));
      var d = r.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { /* lascia stringa */ } }
      if (d && d.ok) return d.dati;
      if (d && d.riprova && t < 5) { $('prog').textContent = 'Limite OpenRouteService raggiunto: nuovo tentativo tra poco…'; await pausa(PAUSA_LIMITE_MS); continue; }
      throw new Error((d && d.errore) || 'Risposta non valida dal servizio distanze');
    }
  }

  /** Decide la posizione: coordinate scritte a mano, posizione già nota, oppure geocodifica dell'indirizzo. */
  async function posizione(indirizzo, coordTxt, esistente) {
    var c = C.leggiCoordinate(coordTxt);
    if (c) {
      if (esistente && vicine(c, esistente)) return { lat: esistente.lat, lng: esistente.lng, geocodifica: esistente.geocodifica, etichetta: null };
      return { lat: c.lat, lng: c.lng, geocodifica: 'manuale', etichetta: null };
    }
    if (esistente && esistente.lat != null && esistente.indirizzo === indirizzo && esistente.geocodifica !== 'manuale' && esistente.geocodifica !== 'calcolato') {
      return { lat: esistente.lat, lng: esistente.lng, geocodifica: esistente.geocodifica, etichetta: null };
    }
    var g = await ors('geocodifica', { testo: indirizzo });
    if (!g) throw new Error('Indirizzo non trovato: "' + indirizzo + '". Correggerlo oppure inserire le coordinate.');
    var pos = { lat: g.lat, lng: g.lng, geocodifica: g.livello || '', etichetta: g.indirizzo };
    return await controllaComune(pos, indirizzo);
  }

  /** Se il punto trovato è lontano dal comune indicato nell'indirizzo, usa il centro del comune e segnala. */
  var cacheComuni = {};
  var DISTANZA_MAX_COMUNE_KM = 25;
  async function centroComune(comune) {
    if (!(comune in cacheComuni)) cacheComuni[comune] = await ors('geocodifica', { testo: comune });
    return cacheComuni[comune];
  }
  /**
   * Controllo di coerenza della posizione trovata con la provincia e il comune dell'indirizzo:
   * - provincia diversa da quella indicata: si cerca il comune; se anche il comune non è nella provincia, la posizione è da correggere a mano;
   * - stessa provincia ma oltre 25 km dal centro del comune: si usa il centro del comune.
   */
  async function controllaComune(pos, indirizzo) {
    var comune = C.comuneDaIndirizzo(indirizzo), prov = C.provinciaDaIndirizzo(indirizzo);
    if (!comune) return pos;
    var provPos = C.provinciaDaEtichetta(pos.etichetta);
    var c = await centroComune(comune);
    var cValido = c && (!prov || C.provinciaDaEtichetta(c.indirizzo) === prov);
    // sigla di provincia diversa ma comune giusto (es. province ridisegnate: Cutro era CZ, oggi KR): la posizione va bene
    var nomeComune = C.normTesto(comune.replace(/\(.*\)/, ''));
    if (prov && provPos && provPos !== prov && nomeComune && C.normTesto(C.comuneDaEtichetta(pos.etichetta)) === nomeComune) return pos;
    if (prov && provPos && provPos !== prov) {
      if (cValido) return { lat: c.lat, lng: c.lng, geocodifica: 'fuori_comune', etichetta: c.indirizzo + ' (per la via era stato trovato un punto in provincia di ' + provPos + ': usato il centro del comune)' };
      return { lat: pos.lat, lng: pos.lng, geocodifica: 'provincia_errata', etichetta: pos.etichetta + ' (provincia diversa da ' + prov + ': inserire le coordinate)' };
    }
    if (['locality', 'localadmin', 'borough', 'neighbourhood', 'postalcode'].indexOf(pos.geocodifica) >= 0) return pos;
    if (cValido && C.distanzaKm(pos, c) > DISTANZA_MAX_COMUNE_KM) {
      return { lat: c.lat, lng: c.lng, geocodifica: 'fuori_comune', etichetta: c.indirizzo + ' (il punto trovato per la via era a ' + Math.round(C.distanzaKm(pos, c)) + ' km: usato il centro del comune)' };
    }
    return pos;
  }

  /* ============================ distanze ============================ */
  function mappaDist() { var m = {}; S.dist.forEach(function (d) { m[d.sede + '#' + d.pv] = d; }); return m; }
  function sediAttive() { return C.CODICI_SEDI.filter(function (c) { return S.sedi[c] && S.sedi[c].lat != null; }); }

  function coppieMancanti(pvLista) {
    var m = mappaDist(), out = [];
    sediAttive().forEach(function (c) {
      pvLista.forEach(function (p) {
        var d = m[c + '#' + p.codice];
        if (!d || d.chiave !== C.chiaveCoord(S.sedi[c], p)) out.push({ sede: c, pv: p });
      });
    });
    return out;
  }

  function registraDistanze(righe) {
    var m = mappaDist();
    righe.forEach(function (r) { m[r.sede + '#' + r.pv] = r; });
    S.dist = Object.keys(m).map(function (k) { return m[k]; });
  }

  /** Calcola le coppie sede-PV indicate con la matrice ORS; salva man mano. */
  async function calcolaDistanze(coppie, avanzamento) {
    var esito = { calcolate: 0, errori: [] };
    if (!coppie.length) return esito;
    var richieste = [];
    var pvUnico = coppie.every(function (c) { return c.pv.codice === coppie[0].pv.codice; });
    if (pvUnico) richieste.push({ sedi: coppie.map(function (c) { return c.sede; }), pv: [coppie[0].pv] });
    else {
      var perSede = {};
      coppie.forEach(function (c) { (perSede[c.sede] = perSede[c.sede] || []).push(c.pv); });
      Object.keys(perSede).forEach(function (s) { C.aBlocchi(perSede[s], BLOCCO_MATRICE).forEach(function (b) { richieste.push({ sedi: [s], pv: b }); }); });
    }
    for (var k = 0; k < richieste.length; k++) {
      var q = richieste[k];
      if (k > 0) await pausa(PAUSA_MATRICE_MS);
      var res;
      try {
        res = await ors('matrice', { origini: q.sedi.map(function (s) { return { lat: S.sedi[s].lat, lng: S.sedi[s].lng }; }), destinazioni: q.pv.map(function (p) { return { lat: p.lat, lng: p.lng }; }) });
      } catch (e) {
        q.sedi.forEach(function (s) { q.pv.forEach(function (p) { esito.errori.push({ sede: s, pv: p.codice, motivo: e.message }); }); });
        if (/non raggiungibile|ORS_API_KEY|401|403/.test(e.message)) throw e;
        continue;
      }
      var righe = [];
      q.sedi.forEach(function (s, i) {
        q.pv.forEach(function (p, j) {
          var km = res.km[i] && res.km[i][j], min = res.minuti[i] && res.minuti[i][j];
          if (km == null || min == null) { esito.errori.push({ sede: s, pv: p.codice, motivo: 'percorso per mezzi pesanti non trovato' }); return; }
          righe.push({ sede: s, pv: p.codice, km: km, minuti: min, chiave: C.chiaveCoord(S.sedi[s], p), aggiornato_il: new Date().toISOString() });
        });
      });
      await upsert('distanze', righe, 'sede,pv');
      registraDistanze(righe.map(function (r) { return { sede: r.sede, pv: r.pv, km: r.km, minuti: r.minuti, chiave: r.chiave }; }));
      esito.calcolate += righe.length;
      if (avanzamento) avanzamento(k + 1, richieste.length, esito);
    }
    return esito;
  }

  /* ============================ schede e stato ============================ */
  var schedaCorrente = 'pv';
  function mostraScheda(t) {
    schedaCorrente = t;
    Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (x) { x.classList.toggle('on', x.dataset.tab === t); });
    ['login', 'pv', 'riep', 'conf'].forEach(function (n) { $('tab-' + n).hidden = n !== t; });
    if (t === 'riep') disegnaRiepilogo();
  }
  Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (b) {
    b.addEventListener('click', function () { mostraScheda(b.dataset.tab); });
  });

  function disegnaTutto() {
    var p = S.P;
    $('pEuroKm').value = fmt(p.euro_km, 2).replace(/\./g, '');
    $('pKmFatt').value = p.km_fatturati;
    $('pCap').value = fmt(p.capacita_pallet, 0).replace(/\./g, '');
    $('pFisso').value = fmt(p.costo_fisso_viaggio, 2).replace(/\./g, '');
    $('pSett').value = p.settimane_anno;
    $('pGiorni').value = p.giorni_settimana;
    disegnaReparti();
    disegnaTariffe();
    disegnaGasolioConf();
    $('pvLista').innerHTML = S.pv.map(function (x) { return '<option value="' + esc(x.codice) + '">' + esc(x.nome) + '</option>'; }).join('');
    $('sediForm').innerHTML = ['ATTUALE', 'OPZ1', 'OPZ2', 'OPZ3'].map(function (c) {
      var s = S.sedi[c], pr = s.lat != null ? precisione(s.geocodifica) : null;
      return '<div class="sede" data-codice="' + c + '"><b>' + nomeSede(c) + '</b>' +
        '<label>Nome<input class="sNome" value="' + esc(s.nome) + '"></label>' +
        '<label>Indirizzo' + (pr ? ' <span class="' + (pr.livello === 'ok' ? '' : 'avviso') + '">· ' + esc(pr.testo) + '</span>' : '') + '<input class="sInd" value="' + esc(s.indirizzo) + '"></label>' +
        '<label>Coordinate<input class="sCoord" value="' + esc(coordTesto(s)) + '" placeholder="vuoto = dall\'indirizzo"></label>' +
        '<label>Capacità mezzo<input class="sCap" inputmode="decimal" value="' + (s.capacita == null ? '' : s.capacita) + '"></label>' +
        '<button class="btn sSalva">Salva</button></div>';
    }).join('');
    var o = S.sedi.OTTIMO;
    $('ottimoInfo').textContent = o.lat != null ? o.indirizzo + '  (' + coordTesto(o) + ')' : 'Non calcolato';
    if (schedaCorrente === 'riep') disegnaRiepilogo();
  }

  function anniTariffe() { return S.tariffe.map(function (t) { return t.anno; }).filter(function (a, i, x) { return x.indexOf(a) === i; }).sort(); }
  function annoTariffaInUso() { var a = anniTariffe(); return S.P.anno_tariffa && a.indexOf(S.P.anno_tariffa) >= 0 ? S.P.anno_tariffa : a[a.length - 1]; }

  function disegnaTariffe() {
    var anni = anniTariffe(), h;
    if (!anni.length) h = '<p class="muted">Nessun tariffario inserito: i costi sono calcolati con la tariffa €/km dei parametri.</p>';
    else {
      var inUso = annoTariffaInUso();
      h = '<div class="grid"><label>Tariffario in uso<select id="selAnnoTariffa">' + anni.map(function (a) { return '<option value="' + a + '"' + (a === inUso ? ' selected' : '') + '>' + a + '</option>'; }).join('') +
        '</select></label></div><div class="scroll"><table><thead><tr><th>Anno</th><th>Mezzo</th><th>Km da</th><th>Km a</th><th>€/km</th><th>€ fisso</th></tr></thead><tbody>' +
        S.tariffe.filter(function (t) { return t.anno === inUso; }).sort(function (a, b) { return (a.mezzo > b.mezzo ? 1 : a.mezzo < b.mezzo ? -1 : 0) || a.km_da - b.km_da; }).map(function (t) {
          return '<tr><td>' + t.anno + '</td><td>' + esc(t.mezzo === '*' ? 'tutti' : t.mezzo) + '</td><td>' + fmt(t.km_da, 0) + '</td><td>' + (t.km_a == null ? 'oltre' : fmt(t.km_a, 0)) + '</td><td>' + fmt(t.euro_km, 3) + '</td><td>' + fmt(t.euro_fisso, 2) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    $('tariffeInfo').innerHTML = h;
  }
  $('tariffeInfo').addEventListener('change', function (ev) {
    if (ev.target.id !== 'selAnnoTariffa') return;
    var a = Number(ev.target.value);
    esegui(async function () {
      await aggiorna('parametri', 'id', 1, { anno_tariffa: a, aggiornato_il: new Date().toISOString() });
      S.P.anno_tariffa = a; disegnaTutto(); msg('Tariffario ' + a + ' in uso.', 'ok');
    }).catch(function () {});
  });
  $('fileTariffe').addEventListener('change', function () {
    var f = this.files && this.files[0]; if (!f) return;
    var input = this;
    esegui(async function () {
      var righe = await leggiEPrepara(f, 'tariffe');
      var annoTxt = $('annoTariffe').value.trim();
      var annoDef = annoTxt ? Math.round(C.num(annoTxt, 'anno')) : null;
      righe.forEach(function (t) { if (!t.anno) t.anno = annoDef; });
      if (righe.some(function (t) { return !(t.anno >= 2000 && t.anno <= 2100); })) throw new Error('Indicare l\'anno di validità del tariffario (colonna "anno" nel file oppure campo Anno).');
      var anni = righe.map(function (t) { return t.anno; }).filter(function (a, i, x) { return x.indexOf(a) === i; });
      var rr = await sb.from('tariffe').delete().in('anno', anni);
      if (rr.error) throw errDb(rr.error);
      var ins = await sb.from('tariffe').insert(righe);
      if (ins.error) throw errDb(ins.error);
      await caricaDati(); disegnaTutto();
      msg('Tariffario ' + anni.join(', ') + ' caricato: ' + righe.length + ' righe.', 'ok');
    }, 'Caricamento del tariffario…').catch(function () {}).then(function () { input.value = ''; });
  });

  /* ============================ gasolio e CO2 ============================ */
  function percento(x) { return fmt(x * 100, 1).replace(/\./g, ''); }
  function mesiGasolioNecessari() {
    var m = {};
    S.viaggi.forEach(function (v) { m[C.meseDi(v.data, 0)] = true; });
    Object.keys(S.gasolio).forEach(function (k) { m[k] = true; });
    return Object.keys(m).sort();
  }
  function nomeMese(k) { var n = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic']; return n[Number(k.slice(5, 7)) - 1] + ' ' + k.slice(0, 4); }
  function disegnaGasolioConf() {
    var G = C.parametriGasolio(S.P);
    $('gRif').value = fmt(G.rif, 3).replace(/\./g, ''); $('gQuota').value = percento(G.quota); $('gFranchigia').value = percento(G.franchigia);
    $('gConsMot').value = fmt(G.consumoMotrice, 2); $('gConsBil').value = fmt(G.consumoBilico, 2); $('gCo2').value = fmt(G.co2, 2);
    var h;
    if (!S.gasolioOk) h = '<div class="alert warn">Tabella "gasolio" assente nel database: eseguire la parte "Versione 4" di supabase/schema.sql.</div>';
    else {
      var mesi = mesiGasolioNecessari();
      h = '<p class="muted">Prezzo medio mensile del gasolio €/l (netto IVA e accise rimborsate). ' + (mesi.length ? 'Sono elencati i mesi che servono ai viaggi importati.' : 'Importare i viaggi per vedere i mesi da compilare.') + '</p>';
      if (mesi.length) h += '<div class="grid">' + mesi.map(function (k) {
        return '<label>' + esc(nomeMese(k)) + '<input class="gPrezzo" data-mese="' + esc(k) + '" inputmode="decimal" placeholder="€/l" value="' + (S.gasolio[k] ? fmt(S.gasolio[k], 3) : '') + '"></label>';
      }).join('') + '</div>';
    }
    $('gasolioMesi').innerHTML = h;
  }
  $('btnGasolio').addEventListener('click', function () {
    esegui(async function () {
      var pc = function (id, nome, max) { var x = C.num($(id).value, nome); if (!(x >= 0 && x < max)) throw new Error(nome + ': valore fuori intervallo.'); return x / 100; };
      var pos = function (id, nome, max) { var x = C.num($(id).value, nome); if (!(x > 0 && x < max)) throw new Error(nome + ': valore fuori intervallo.'); return x; };
      var v = { gas_rif: pos('gRif', 'prezzo di riferimento', 10), gas_quota: pc('gQuota', 'quota legata al gasolio', 100.0001), gas_franchigia: pc('gFranchigia', 'franchigia', 100),
        consumo_motrice: pos('gConsMot', 'consumo motrice', 2), consumo_bilico: pos('gConsBil', 'consumo bilico', 2), co2_kg_l: pos('gCo2', 'CO₂ per litro', 10) };
      if (!S.gasolioOk) throw new Error('Tabella "gasolio" assente: eseguire la parte "Versione 4" di supabase/schema.sql.');
      var nuovi = [], vuoti = [];
      Array.prototype.forEach.call(document.querySelectorAll('#gasolioMesi .gPrezzo'), function (i) {
        var t = i.value.trim();
        if (t === '') { if (S.gasolio[i.dataset.mese]) vuoti.push(i.dataset.mese); return; }
        var x = C.num(t, 'prezzo di ' + nomeMese(i.dataset.mese));
        if (!(x > 0.3 && x < 5)) throw new Error('Prezzo di ' + nomeMese(i.dataset.mese) + ' non plausibile: ' + t + ' €/l.');
        nuovi.push({ mese: i.dataset.mese, prezzo: x });
      });
      await aggiorna('parametri', 'id', 1, Object.assign({ aggiornato_il: new Date().toISOString() }, v));
      if (nuovi.length) await upsert('gasolio', nuovi, 'mese');
      await elimina('gasolio', 'mese', vuoti);
      Object.assign(S.P, v);
      nuovi.forEach(function (r) { S.gasolio[r.mese] = r.prezzo; }); vuoti.forEach(function (k) { delete S.gasolio[k]; });
      disegnaTutto(); msg('Gasolio salvato: ' + nuovi.length + ' prezzi mensili.', 'ok');
    }).catch(function () {});
  });
  $('fileGasolio').addEventListener('change', function () {
    var f = this.files && this.files[0], input = this; if (!f) return;
    esegui(async function () {
      if (!S.gasolioOk) throw new Error('Tabella "gasolio" assente: eseguire la parte "Versione 4" di supabase/schema.sql.');
      var b = await f.arrayBuffer();
      var righe = /\.(csv|txt)$/i.test(f.name) ? C.leggiCSV(new TextDecoder('utf-8').decode(b)) : C.righeDaExcel(window.XLSX, new Uint8Array(b));
      var prezzi = C.preparaPrezziGasolio(righe);
      var strani = prezzi.filter(function (p) { return !(p.prezzo > 0.3 && p.prezzo < 5); });
      if (strani.length) throw new Error('Prezzi non plausibili per: ' + strani.map(function (p) { return p.mese + ' (' + p.prezzo + ' €/l)'; }).join(', '));
      await upsert('gasolio', prezzi, 'mese');
      prezzi.forEach(function (p) { S.gasolio[p.mese] = p.prezzo; });
      disegnaTutto();
      msg('Prezzi del gasolio caricati: ' + prezzi.length + ' mesi (' + nomeMese(prezzi[0].mese) + ' – ' + nomeMese(prezzi[prezzi.length - 1].mese) + ').', 'ok');
    }, 'Lettura della tabella del gasolio…').catch(function () {}).then(function () { input.value = ''; });
  });
  function calcoloGasolio(R) { return C.gasolioViaggi(R || ricalcoloViaggi(), S.gasolio, C.parametriGasolio(S.P)); }
  function disegnaGasolio(R) {
    var box = $('gasolio');
    if (!conViaggi()) { box.hidden = true; box.innerHTML = ''; return; }
    R = R || ricalcoloViaggi(); var g = calcoloGasolio(R), G = g.parametri;
    var h = '<h2>Gasolio e CO₂</h2><p class="muted">Adeguamento gasolio: ' + percento(G.quota) + '% della tariffa, riferimento ' + fmt(G.rif, 3) + ' €/l, franchigia ' + percento(G.franchigia) +
      '% sottratta dalla variazione; prezzo medio dello stesso mese dei viaggi). CO₂: consumo ' + fmt(G.consumoMotrice, 2) + ' l/km motrice, ' + fmt(G.consumoBilico, 2) + ' l/km bilico, ' + fmt(G.co2, 2) + ' kg/l. Valori annui = periodo × ' + fmt(R.periodo.fattoreAnno, 2) + '.</p>';
    if (!S.gasolioOk) h += '<div class="alert warn">Tabella "gasolio" assente nel database: l\'adeguamento è calcolato a zero. Eseguire la parte "Versione 4" di supabase/schema.sql.</div>';
    else if (g.mesiMancanti.length) h += '<div class="alert warn">Prezzo del gasolio mancante per: ' + g.mesiMancanti.map(nomeMese).join(', ') + '. Per quei mesi l\'adeguamento è calcolato a zero: inserirlo in Configurazione.</div>';
    h += '<div class="scroll"><table><thead><tr><th>Sede</th><th>Litri / anno</th><th>CO₂ t / anno</th><th>Δ CO₂ t / anno vs attuale</th><th>Δ CO₂ %</th>' +
      '<th>Adeguamento gasolio / anno</th><th>Δ adeguamento / anno</th><th>Costo con adeguamento / anno</th><th>Δ costo con adeguamento / anno</th></tr></thead><tbody>' +
      g.sedi.map(function (s) {
        var d = s.delta;
        return '<tr><td><b>' + esc(S.sedi[s.codice].nome) + '</b></td><td>' + fmt(s.anno.litri, 0) + '</td><td>' + fmt(s.anno.co2, 1) + '</td>' +
          '<td>' + (d ? segno(d.co2, 1, ' t') : '') + '</td><td>' + (d && d.co2Pct != null ? segno(d.co2Pct, 1, ' %') : '') + '</td>' +
          '<td>' + eur(s.anno.adeguamento) + '</td><td>' + (d ? segno(d.adeguamento, 0, ' €') : '') + '</td>' +
          '<td>' + eur(s.anno.costoTotale) + '</td><td>' + (d ? segno(d.costoTotale, 0, ' €') : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    h += '<details><summary>Adeguamento mese per mese</summary><div class="scroll"><table><thead><tr><th>Mese dei viaggi</th><th>Prezzo medio del mese</th><th>Variazione</th><th>Adeguamento sulla tariffa</th><th>Viaggi</th></tr></thead><tbody>' +
      g.mesi.map(function (m) {
        return '<tr><td>' + esc(nomeMese(m.mese)) + '</td><td>' + (m.prezzo == null ? '<span class="avviso">mancante</span>' : fmt(m.prezzo, 3) + ' €/l') + '</td>' +
          '<td>' + (m.variazione == null ? '—' : segno(m.variazione * 100, 2, ' %')) + '</td><td>' + (m.mancante ? '—' : m.applicato ? segno(m.adeguamento * 100, 2, ' %') : '0 (entro la franchigia)') + '</td><td>' + fmt(m.viaggi, 0) + '</td></tr>';
      }).join('') + '</tbody></table></div></details>';
    box.innerHTML = h; box.hidden = false;
  }

  function disegnaReparti() {
    var nomi = Object.keys(S.reparti).sort();
    var v = S.vol;
    var h = v ? '<p class="muted">Carichi giornalieri: ' + S.carichi.length + ' righe, ' + v.giorni + ' giorni dal ' + esc(v.dal) + ' al ' + esc(v.al) +
      ' (' + fmt(v.settimane, 2) + ' settimane con ' + fmt(S.P.giorni_settimana, 0) + ' giorni lavorativi).</p>' : '<p class="muted">Nessun carico giornaliero importato.</p>';
    if (nomi.length) {
      h += '<div class="grid">' + nomi.map(function (n) {
        return '<label>' + esc(n) + ' — colli per pallet<input class="rFatt" data-reparto="' + esc(n) + '" inputmode="decimal" value="' + (S.reparti[n] == null ? '' : String(S.reparti[n]).replace('.', ',')) + '"></label>';
      }).join('') + '</div><button class="btn" id="btnReparti">Salva fattori</button>';
    }
    if (v && v.repartiSenzaFattore.length) h += '<div class="alert warn">Mancano i fattori di conversione per: ' + v.repartiSenzaFattore.map(esc).join(', ') + '. Finché mancano, i PV con quei reparti non entrano nei calcoli.</div>';
    $('repartiForm').innerHTML = h;
  }
  $('repartiForm').addEventListener('click', function (ev) {
    if (ev.target.id !== 'btnReparti') return;
    esegui(async function () {
      var righe = Array.prototype.map.call(document.querySelectorAll('#repartiForm .rFatt'), function (i) {
        var t = i.value.trim(), f = t === '' ? null : C.num(t, 'colli per pallet (' + i.dataset.reparto + ')');
        if (f !== null && !(f > 0)) throw new Error('Il fattore per ' + i.dataset.reparto + ' deve essere maggiore di zero.');
        return { reparto: i.dataset.reparto, colli_per_pallet: f, aggiornato_il: new Date().toISOString() };
      });
      await upsert('reparti', righe, 'reparto');
      righe.forEach(function (r) { S.reparti[r.reparto] = r.colli_per_pallet; });
      ricalcolaVolumi(); disegnaTutto();
      msg('Fattori di conversione salvati.', 'ok');
    }).catch(function () {});
  });

  /* ============================ maschera 1 ============================ */
  var pvCorrente = null;
  function compilaPV(p) {
    pvCorrente = p || null;
    $('pvCodice').value = p ? p.codice : ''; $('pvNome').value = p ? p.nome : ''; $('pvIndirizzo').value = p ? p.indirizzo : '';
    $('pvPallet').value = p && p.pallet != null ? String(p.pallet).replace('.', ',') : ''; $('pvConsegne').value = p && p.consegne != null ? String(p.consegne).replace('.', ',') : '';
    $('pvCoord').value = p && p.geocodifica === 'manuale' ? coordTesto(p) : '';
  }
  function trovaPV(codice) { return S.pv.filter(function (x) { return x.codice === codice; })[0]; }

  $('pvCerca').addEventListener('change', function () {
    var v = this.value.trim(); if (!v) return;
    var p = trovaPV(v) || S.pv.filter(function (x) { return x.nome.toLowerCase() === v.toLowerCase(); })[0];
    if (!p) { msg('Punto vendita "' + esc(v) + '" non trovato.', 'warn'); return; }
    msg(''); compilaPV(p); confrontoPV(p);
  });
  $('btnNuovoPV').addEventListener('click', function () { $('pvCerca').value = ''; compilaPV(null); $('confronto').innerHTML = '<span class="muted">Inserisci i dati del nuovo punto vendita.</span>'; msg(''); });

  $('btnSalvaPV').addEventListener('click', function () {
    esegui(async function () {
      var codice = $('pvCodice').value.trim(), indirizzo = $('pvIndirizzo').value.trim().replace(/\s+/g, ' ');
      if (!codice) throw new Error('Inserire il codice del punto vendita.');
      if (!indirizzo) throw new Error('Inserire l\'indirizzo del punto vendita.');
      if (C.pvFuoriPerimetro({ indirizzo: indirizzo })) throw new Error('Punto vendita in Campania: è fuori dal perimetro dello studio e non viene inserito.');
      var esistente = trovaPV(codice);
      var conCarichi = !!(esistente && esistente.haCarichi);
      var pTxt = $('pvPallet').value.trim(), cTxt = $('pvConsegne').value.trim();
      // pallet e consegne a settimana sono facoltativi: servono solo senza viaggi reali né carichi giornalieri
      var pallet = pTxt === '' ? null : C.num(pTxt, 'pallet/settimana');
      var consegne = cTxt === '' ? null : C.num(cTxt, 'consegne/settimana');
      if ((pallet === null) !== (consegne === null)) throw new Error('Indicare sia i pallet sia le consegne a settimana, oppure lasciarli vuoti entrambi.');
      if (pallet !== null && !(pallet > 0)) throw new Error('I pallet/settimana devono essere maggiori di zero.');
      if (consegne !== null && !(consegne > 0)) throw new Error('Le consegne/settimana devono essere maggiori di zero.');
      if (esistente && (!pvCorrente || pvCorrente.codice !== codice) && !window.confirm('Il codice ' + codice + ' esiste già. Sovrascrivere i suoi dati?')) throw new Error('Salvataggio annullato.');
      var pos = await posizione(indirizzo, $('pvCoord').value, esistente);
      var pv = { codice: codice, nome: $('pvNome').value.trim(), indirizzo: indirizzo, lat: pos.lat, lng: pos.lng, pallet: pallet, consegne: consegne, geocodifica: pos.geocodifica,
        carico: esistente ? esistente.carico : null, haCarichi: !!conCarichi };
      await upsert('punti_vendita', [aDbPV(pv)], 'codice');
      if (esistente && !vicine(pv, esistente)) { await elimina('distanze', 'pv', [codice]); S.dist = S.dist.filter(function (d) { return d.pv !== codice; }); }
      S.pv = S.pv.filter(function (x) { return x.codice !== codice; }).concat([pv]); ordinaPV();
      disegnaTutto(); compilaPV(pv); $('pvCerca').value = codice;
      var es = await calcolaDistanze(coppieMancanti([pv]));
      disegnaConfronto(pv, es.errori);
      var pr = precisione(pv.geocodifica);
      msg('Punto vendita ' + esc(codice) + ' salvato' + (pos.etichetta ? ' — posizione trovata: ' + esc(pos.etichetta) : '') + ' (' + esc(pr.testo) + ').', pr.livello === 'ok' ? 'ok' : 'warn');
    }).catch(function () {});
  });

  $('btnEliminaPV').addEventListener('click', function () {
    var c = $('pvCodice').value.trim();
    if (!c || !trovaPV(c)) { msg('Selezionare un punto vendita esistente.', 'err'); return; }
    if (!window.confirm('Eliminare il punto vendita ' + c + '?')) return;
    esegui(async function () {
      await elimina('punti_vendita', 'codice', [c]);
      S.pv = S.pv.filter(function (x) { return x.codice !== c; }); S.dist = S.dist.filter(function (d) { return d.pv !== c; });
      S.carichi = S.carichi.filter(function (x) { return x.pv !== c; }); ricalcolaVolumi();
      disegnaTutto(); $('pvCerca').value = ''; compilaPV(null);
      $('confronto').innerHTML = '<span class="muted">Inserisci o cerca un punto vendita per vedere il confronto.</span>';
      msg('Punto vendita ' + esc(c) + ' eliminato.', 'ok');
    }).catch(function () {});
  });

  function confrontoPV(p) {
    esegui(async function () {
      var es = await calcolaDistanze(coppieMancanti([p]));
      msg(''); disegnaConfronto(p, es.errori);
    }).catch(function () {});
  }

  function disegnaConfronto(pv, errori) {
    if (conViaggi()) return disegnaConfrontoViaggi(pv, errori);
    var m = mappaDist();
    var col = sediAttive().map(function (c) {
      var d = m[c + '#' + pv.codice];
      var met = d && d.chiave === C.chiaveCoord(S.sedi[c], pv) ? C.metriche(pv, S.sedi[c], d, S.P) : null;
      return { codice: c, nome: S.sedi[c].nome, indirizzo: S.sedi[c].indirizzo, m: met };
    });
    var att = col.filter(function (c) { return c.codice === 'ATTUALE'; })[0];
    col.forEach(function (c) { c.delta = c.codice === 'ATTUALE' ? null : C.delta(c.m, att && att.m); });
    if (!col.length) { $('confronto').innerHTML = '<span class="muted">Nessuna sede configurata: compilare la scheda Configurazione.</span>'; return; }
    var righe = [
      ['Km stradali mezzi pesanti (andata)', function (c) { return c.m ? fmt(c.m.km, 1) : '—'; }],
      ['Tempo di guida (andata)', function (c) { return c.m ? fmt(c.m.minuti, 0) + ' min' : '—'; }],
      ['Pallet / settimana', function (c) { return c.m ? fmt(c.m.palletSett, 1) : '—'; }],
      ['Viaggi / settimana', function (c) { return c.m ? fmt(c.m.viaggiSett, 1) : '—'; }],
      ['Costo per viaggio', function (c) { return c.m ? eur(c.m.costoViaggio, 2) : '—'; }],
      ['Costo / settimana', function (c) { return c.m ? eur(c.m.costoSett, 0) : '—'; }],
      ['Costo / anno', function (c) { return c.m ? eur(c.m.costoAnno, 0) : '—'; }],
      null,
      ['Δ km vs attuale', function (c) { return c.delta ? segno(c.delta.km, 1) : ''; }],
      ['Δ viaggi / settimana', function (c) { return c.delta ? segno(c.delta.viaggiSett, 1) : ''; }],
      ['Δ costo / anno', function (c) { return c.delta ? segno(c.delta.costoAnno, 0, ' €') : ''; }],
      ['Δ % costo', function (c) { return c.delta && c.delta.pct != null ? segno(c.delta.pct, 1, ' %') : ''; }]
    ];
    var pr = precisione(pv.geocodifica);
    var vol = C.volumePV(pv, S.P.capacita_pallet);
    var testoVol = vol ? fmt(vol.palletSett, 1) + ' pallet/settimana in ' + fmt(vol.consegneSett, 1) + ' consegne' + (pv.carico ? ' (dai carichi giornalieri)' : '')
      : '<span class="avviso">volumi non calcolabili' + (pv.haCarichi ? ': mancano i fattori di conversione colli → pallet' : ': inserire pallet e consegne a settimana') + '</span>';
    var h = '<h2>' + esc(pv.codice + (pv.nome ? ' – ' + pv.nome : '')) + '</h2>' +
      '<p class="muted">' + esc(pv.indirizzo) + ' · <span class="' + (pr.livello === 'ok' ? '' : 'avviso') + '">' + esc(pr.testo) + '</span> · ' + testoVol + '</p>' +
      '<div class="scroll"><table><thead><tr><th></th>' + col.map(function (c) {
        return '<th>' + esc(c.nome) + '<span class="sub">' + esc(c.indirizzo) + '</span></th>';
      }).join('') + '</tr></thead><tbody>' + righe.map(function (rg) {
        if (!rg) return '<tr class="sep"><td colspan="' + (col.length + 1) + '">Scostamenti rispetto al CEDI attuale</td></tr>';
        return '<tr><td>' + rg[0] + '</td>' + col.map(function (c) { return '<td>' + rg[1](c) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
    if (errori && errori.length) h += '<div class="alert err">' + errori.map(function (e) { return esc(S.sedi[e.sede].nome + ' → ' + e.pv + ': ' + e.motivo); }).join('<br>') + '</div>';
    $('confronto').innerHTML = h;
  }

  function disegnaConfrontoViaggi(pv, errori) {
    var m = mappaDist(), R = ricalcoloViaggi();
    var col = R.attive.map(function (c) {
      var d = m[c + '#' + pv.codice], ok = d && d.chiave === C.chiaveCoord(S.sedi[c], pv);
      return { codice: c, nome: S.sedi[c].nome, indirizzo: S.sedi[c].indirizzo, d: ok ? d : null, x: R.perPV[c][pv.codice] || null };
    });
    if (!col.length) { $('confronto').innerHTML = '<span class="muted">Nessuna sede configurata: compilare la scheda Configurazione.</span>'; return; }
    var att = col.filter(function (c) { return c.codice === 'ATTUALE'; })[0];
    var righe = [
      ['Km stradali mezzi pesanti (andata)', function (c) { return c.d ? fmt(c.d.km, 1) : '—'; }],
      ['Tempo di guida (andata)', function (c) { return c.d ? fmt(c.d.minuti, 0) + ' min' : '—'; }],
      ['Viaggi che lo servono nel periodo', function (c) { return c.x ? fmt(c.x.viaggi, 0) : '—'; }],
      ['Carico nel periodo (unità)', function (c) { return c.x ? fmt(c.x.occ, 1) : '—'; }],
      ['Costo ripartito nel periodo', function (c) { return c.x ? eur(c.x.costo, 0) : '—'; }],
      ['Costo ripartito / anno', function (c) { return c.x ? eur(c.x.costoAnno, 0) : '—'; }],
      null,
      ['Δ km vs attuale', function (c) { return c.codice !== 'ATTUALE' && c.d && att && att.d ? segno(c.d.km - att.d.km, 1) : ''; }],
      ['Δ costo / anno', function (c) { return c.codice !== 'ATTUALE' && c.x && att && att.x ? segno(c.x.costoAnno - att.x.costoAnno, 0, ' €') : ''; }],
      ['Δ % costo', function (c) { return c.codice !== 'ATTUALE' && c.x && att && att.x && att.x.costoAnno ? segno((c.x.costoAnno - att.x.costoAnno) / att.x.costoAnno * 100, 1, ' %') : ''; }]
    ];
    var pr = precisione(pv.geocodifica);
    var nV = 0; col.forEach(function (c) { if (c.x) nV = Math.max(nV, c.x.viaggi); });
    var h = '<h2>' + esc(pv.codice + (pv.nome ? ' – ' + pv.nome : '')) + '</h2>' +
      '<p class="muted">' + esc(pv.indirizzo) + ' · <span class="' + (pr.livello === 'ok' ? '' : 'avviso') + '">' + esc(pr.testo) + '</span> · ' +
      (nV ? 'servito da ' + nV + ' viaggi reali nel periodo; il costo di ogni viaggio è ripartito tra i clienti in base al carico' : '<span class="avviso">nessun viaggio nel periodo importato</span>') + '</p>' +
      '<div class="scroll"><table><thead><tr><th></th>' + col.map(function (c) {
        return '<th>' + esc(c.nome) + '<span class="sub">' + esc(c.indirizzo) + '</span></th>';
      }).join('') + '</tr></thead><tbody>' + righe.map(function (rg) {
        if (!rg) return '<tr class="sep"><td colspan="' + (col.length + 1) + '">Scostamenti rispetto al CEDI attuale</td></tr>';
        return '<tr><td>' + rg[0] + '</td>' + col.map(function (c) { return '<td>' + rg[1](c) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
    if (R.attive.indexOf('OTTIMO') >= 0) h += '<p class="muted">Il punto di ottimo minimizza il costo totale di tutti i viaggi, non quello del singolo cliente: per un punto vendita lontano dall\'ottimo il costo può risultare più alto dell\'attuale.</p>';
    if (errori && errori.length) h += '<div class="alert err">' + errori.map(function (e) { return esc(S.sedi[e.sede].nome + ' → ' + e.pv + ': ' + e.motivo); }).join('<br>') + '</div>';
    $('confronto').innerHTML = h;
  }

  function notaPerimetro() {
    var n = (S.fuoriPerimetro || []).length;
    if (!n && !S.viaggiFuori) return '';
    return '<br>Fuori perimetro (Campania): ' + n + ' punti vendita esclusi da calcoli ed estrazioni' + (S.viaggiFuori ? ', ' + S.viaggiFuori + ' viaggi che servivano solo loro' : '') + '.';
  }

  function disegnaRiepilogoViaggi() {
    var R = ricalcoloViaggi(), ries = C.riepilogoViaggi(S.sedi, R), per = R.periodo;
    if (!ries.length) { $('riepilogo').innerHTML = '<span class="muted">Nessuna sede configurata.</span>'; return; }
    var mancanti = ries.reduce(function (s, x) { return s + x.mancanti; }, 0);
    var nClienti = {}; S.viaggi.forEach(function (v) { v.clienti.forEach(function (c) { nClienti[c.pv] = true; }); });
    var anni = anniTariffe();
    var h = '<p class="muted">Viaggi reali: ' + S.viaggi.length + ' viaggi dal ' + esc(per.dal) + ' al ' + esc(per.al) + ' (' + per.giorni + ' giorni), ' + Object.keys(nClienti).length +
      ' clienti. Km di ogni viaggio = ' + (S.P.km_fatturati === 'AR' ? 'andata e ritorno' : 'sola andata') + ' fino al cliente più lontano del giro. Costo/anno = periodo × ' + fmt(per.fattoreAnno, 2) + '.<br>' +
      (anni.length ? 'Tariffario ' + annoTariffaInUso() + '.' : '<span class="avviso">Tariffario non inserito: costi calcolati con ' + fmt(S.P.euro_km, 2) + ' €/km dei parametri.</span>') + notaPerimetro() + '</p>';
    if (mancanti) h += '<div class="alert warn">' + mancanti + ' calcoli di viaggio non possibili per distanze mancanti: i totali non sono ancora confrontabili. Premere "Aggiorna distanze".</div>';
    h += '<div class="scroll"><table><thead><tr><th>Sede</th><th>Viaggi</th><th>Km fatturati nel periodo</th><th>Costo nel periodo</th><th>Costo / anno</th>' +
      '<th>Δ costo / anno vs attuale</th><th>Δ %</th><th>Δ km nel periodo</th><th>Sopra l\'ottimo</th></tr></thead><tbody>' +
      ries.map(function (s) {
        return '<tr><td><b>' + esc(s.nome) + '</b><span class="sub">' + esc(s.indirizzo) + '</span></td>' +
          '<td>' + fmt(s.viaggi, 0) + '</td><td>' + fmt(s.km, 0) + '</td><td>' + eur(s.costo) + '</td><td>' + eur(s.costoAnno) + '</td>' +
          '<td>' + (s.deltaAnno == null ? '' : segno(s.deltaAnno, 0, ' €')) + '</td>' +
          '<td>' + (s.deltaPct == null ? '' : segno(s.deltaPct, 1, ' %')) + '</td>' +
          '<td>' + (s.deltaKm == null ? '' : segno(s.deltaKm, 0)) + '</td>' +
          '<td>' + (s.sopraOttimo == null ? '' : eur(s.sopraOttimo)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    $('riepilogo').innerHTML = h;
    disegnaGasolio(R);
  }

  /* ============================ maschera 2 ============================ */
  function disegnaRiepilogo() {
    if (conViaggi()) { disegnaRiepilogoViaggi(); disegnaQualita(); return; }
    disegnaGasolio();
    var t = C.tabella(S.P, S.sedi, S.pv, S.dist);
    var ries = C.riepilogo(S.P, S.sedi, t);
    if (!ries.length) { $('riepilogo').innerHTML = '<span class="muted">Nessuna sede configurata.</span>'; $('qualita').innerHTML = ''; return; }
    var mancanti = ries.reduce(function (s, x) { return s + x.mancanti; }, 0);
    var h = '<p class="muted">' + S.pv.length + ' punti vendita (' + t.righe.length + ' con volumi) · tariffa ' + fmt(S.P.euro_km, 2) + ' €/km ' +
      (S.P.km_fatturati === 'AR' ? 'andata e ritorno' : 'solo andata') + ' · mezzo standard ' + fmt(S.P.capacita_pallet, 0) + ' pallet · ' + fmt(S.P.settimane_anno, 0) + ' settimane/anno</p>';
    if (S.vol) h += '<p class="muted">Volumi dai carichi giornalieri: ' + S.vol.giorni + ' giorni (' + esc(S.vol.dal) + ' – ' + esc(S.vol.al) + '), riportati a settimana su ' + fmt(S.P.giorni_settimana, 0) + ' giorni lavorativi.</p>';
    if (t.senzaVolumi.length) h += '<div class="alert warn">' + t.senzaVolumi.length + ' punti vendita esclusi dai totali perché senza volumi' +
      (S.vol && S.vol.repartiSenzaFattore.length ? ' (mancano i fattori colli → pallet per: ' + S.vol.repartiSenzaFattore.map(esc).join(', ') + ')' : ' (nessun carico nel periodo o pallet non indicati)') + '.</div>';
    if (mancanti) h += '<div class="alert warn">Mancano ' + mancanti + ' distanze: i totali non sono ancora confrontabili. Premere "Aggiorna distanze".</div>';
    h += '<div class="scroll"><table><thead><tr><th>Sede</th><th>Viaggi / settimana</th><th>Km fatturati / settimana</th><th>Costo / anno</th>' +
      '<th>Δ costo / anno vs attuale</th><th>Δ %</th><th>Δ viaggi / settimana</th><th>Sopra l\'ottimo</th></tr></thead><tbody>' +
      ries.map(function (s) {
        return '<tr><td><b>' + esc(s.nome) + '</b><span class="sub">' + esc(s.indirizzo) + '</span></td>' +
          '<td>' + fmt(s.viaggiSett, 1) + '</td><td>' + fmt(s.kmSett, 0) + '</td><td>' + eur(s.costoAnno) + '</td>' +
          '<td>' + (s.deltaAnno == null ? '' : segno(s.deltaAnno, 0, ' €')) + '</td>' +
          '<td>' + (s.deltaPct == null ? '' : segno(s.deltaPct, 1, ' %')) + '</td>' +
          '<td>' + (s.deltaViaggi == null ? '' : segno(s.deltaViaggi, 1)) + '</td>' +
          '<td>' + (s.sopraOttimo == null ? '' : eur(s.sopraOttimo)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    $('riepilogo').innerHTML = h;
    disegnaQualita();
  }

  function disegnaQualita() {
    var dubbi = S.pv.filter(function (p) { return precisione(p.geocodifica).livello !== 'ok'; });
    var q = '';
    if (dubbi.length) {
      q += '<h2>Posizioni da verificare (' + dubbi.length + ')</h2><p class="muted">L\'indirizzo è stato trovato solo in modo approssimato: correggere l\'indirizzo o inserire le coordinate nella maschera del punto vendita.</p>' +
        '<div class="scroll"><table><thead><tr><th>Codice</th><th>Nome</th><th>Indirizzo</th><th>Precisione</th></tr></thead><tbody>' +
        dubbi.map(function (p) { return '<tr><td>' + esc(p.codice) + '</td><td class="testo">' + esc(p.nome) + '</td><td class="testo">' + esc(p.indirizzo) + '</td><td class="testo avviso">' + esc(precisione(p.geocodifica).testo) + '</td></tr>'; }).join('') +
        '</tbody></table></div>';
    }
    if (S.ultimiErroriDist.length) {
      q += '<h2>Distanze non calcolate (' + S.ultimiErroriDist.length + ')</h2><div class="scroll"><table><tbody>' +
        S.ultimiErroriDist.map(function (e) { return '<tr><td>' + esc(S.sedi[e.sede].nome) + ' → ' + esc(e.pv) + '</td><td class="testo">' + esc(e.motivo) + '</td></tr>'; }).join('') + '</tbody></table></div>';
    }
    $('qualita').innerHTML = q;
  }

  $('btnDist').addEventListener('click', function () {
    esegui(async function () {
      var coppie = coppieMancanti(S.pv);
      if (!coppie.length) { S.ultimiErroriDist = []; disegnaRiepilogo(); msg('Tutte le distanze sono già calcolate.', 'ok'); return; }
      $('prog').textContent = 'Distanze da calcolare: ' + coppie.length;
      var es = await calcolaDistanze(coppie, function (k, n, e) { $('prog').textContent = 'Richiesta ' + k + ' di ' + n + ' · distanze calcolate: ' + e.calcolate; });
      S.ultimiErroriDist = es.errori;
      disegnaRiepilogo();
      $('prog').textContent = '';
      msg(es.errori.length ? es.calcolate + ' distanze calcolate, ' + es.errori.length + ' non trovate (elenco sotto il riepilogo).' : 'Distanze aggiornate (' + es.calcolate + ' nuove).', es.errori.length ? 'warn' : 'ok');
    }, 'Calcolo distanze in corso…').catch(function () { $('prog').textContent = ''; });
  });

  $('btnVerificaPos').addEventListener('click', function () {
    esegui(async function () {
      // geocodifica di nuovo ogni PV (tranne le coordinate inserite a mano) e applica i controlli su provincia e comune
      var daControllare = S.pv.filter(function (p) { return p.geocodifica !== 'manuale'; });
      var corretti = [];
      for (var i = 0; i < daControllare.length; i++) {
        var p = daControllare[i];
        $('prog').textContent = 'Verifica posizioni: ' + (i + 1) + ' di ' + daControllare.length;
        if (i > 0) await pausa(PAUSA_GEOCODIFICA_MS);
        var nuova;
        try { nuova = await posizione(p.indirizzo, '', null); } catch (e) { if (/non raggiungibile|ORS_API_KEY/.test(e.message)) throw e; continue; }
        if (!vicine(nuova, p) || nuova.geocodifica !== p.geocodifica) {
          corretti.push(p.codice + ' ' + p.nome + ': ' + precisione(nuova.geocodifica).testo + (nuova.etichetta ? ' — ' + nuova.etichetta : ''));
          p.lat = nuova.lat; p.lng = nuova.lng; p.geocodifica = nuova.geocodifica;
          await upsert('punti_vendita', [aDbPV(p)], 'codice');
          await elimina('distanze', 'pv', [p.codice]);
          S.dist = S.dist.filter(function (d) { return d.pv !== p.codice; });
        }
      }
      $('prog').textContent = '';
      disegnaRiepilogo();
      msg(corretti.length ? corretti.length + ' posizioni aggiornate (poi premere "Aggiorna distanze"):<br>' + corretti.map(esc).join('<br>') : 'Tutte le posizioni sono coerenti con comune e provincia (' + daControllare.length + ' controllate).', corretti.length ? 'warn' : 'ok');
    }, 'Verifica delle posizioni…').catch(function () { $('prog').textContent = ''; });
  });

  function datiEstrazione() {
    if (conViaggi()) return C.estrazioneViaggi(S.sedi, ricalcoloViaggi(), mappaPV());
    return C.estrazione(S.P, S.sedi, C.tabella(S.P, S.sedi, S.pv, S.dist));
  }
  function oggi() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  $('btnCsv').addEventListener('click', function () {
    esegui(function () {
      scarica('simulazione_cedi_' + oggi() + '.csv', new Blob([C.csv(datiEstrazione())], { type: 'text/csv;charset=utf-8' }));
      msg('CSV generato.', 'ok');
    }).catch(function () {});
  });

  $('btnXlsx').addEventListener('click', function () {
    esegui(async function () {
      var d = datiEstrazione();
      var wb = new window.ExcelJS.Workbook();
      wb.creator = 'Simulatore CEDI'; wb.created = new Date();
      function foglio(nome, intest, righe, formati) {
        var ws = wb.addWorksheet(nome, { views: [{ state: 'frozen', ySplit: 1 }] });
        ws.addRow(intest).font = { bold: true };
        righe.forEach(function (r) { ws.addRow(r); });
        intest.forEach(function (h, i) {
          var col = ws.getColumn(i + 1);
          col.width = Math.min(45, Math.max(10, String(h).length + 2));
          if (formati && formati[i]) col.numFmt = formati[i];
        });
        return ws;
      }
      if (d.viaggi) {
        foglio('Riepilogo', d.intestazioneRiepilogo, d.riepilogo, [null, null, '#,##0', '#,##0', '#,##0', '#,##0', '#,##0', '0.0', '#,##0']);
        foglio('Dettaglio PV', d.intestazione, d.righe, [null, null, null, '#,##0', '#,##0', '#,##0', '#,##0', '0.0']);
        foglio('Viaggi', d.intestazioneViaggi, d.viaggi, null);
        var eg = C.estrazioneGasolio(S.sedi, calcoloGasolio());
        foglio('Gasolio e CO2', eg.intestazione, eg.righe, [null, '#,##0', '#,##0', '#,##0.0', '#,##0', '#,##0', '#,##0.0', '#,##0.0', '0.0', '#,##0', '#,##0', '#,##0', '#,##0']);
        foglio('Gasolio mesi', eg.intestazioneMesi, eg.mesi, [null, null, '0.000', '0.00', null, '0.00', '#,##0']);
      } else {
        foglio('Riepilogo', d.intestazioneRiepilogo, d.riepilogo, [null, null, '0.0', '#,##0', '#,##0', '#,##0', '0.0', '#,##0']);
        foglio('Dettaglio', d.intestazione, d.righe, [null, null, null, '0.0', '0.0', '0.0', '0.0', '#,##0.00', '#,##0', '#,##0', '0.0']);
      }
      var per = conViaggi() ? C.periodoViaggi(S.viaggi) : null;
      foglio('Parametri', ['Parametro', 'Valore'], (per ? [['Metodo', 'Ricalcolo dei viaggi reali da ogni sede'], ['Periodo viaggi', per.dal + ' – ' + per.al + ' (' + per.giorni + ' giorni)'],
        ['Viaggi', S.viaggi.length], ['Tariffario', S.tariffe.length ? 'anno ' + annoTariffaInUso() : 'non inserito (€/km dei parametri)']].concat((function () {
          var G = C.parametriGasolio(S.P);
          return [['Gasolio: prezzo di riferimento €/l', G.rif], ['Gasolio: quota della tariffa', G.quota], ['Gasolio: franchigia', G.franchigia],
            ['Consumo motrice l/km', G.consumoMotrice], ['Consumo bilico l/km', G.consumoBilico], ['CO₂ kg per litro', G.co2]];
        })()) : []).concat([
        ['Tariffa €/km', S.P.euro_km], ['Km fatturati', S.P.km_fatturati === 'AR' ? 'andata e ritorno' : 'solo andata'],
        ['Capacità mezzo standard (pallet)', S.P.capacita_pallet], ['Costo fisso per viaggio €', S.P.costo_fisso_viaggio],
        ['Settimane operative/anno', S.P.settimane_anno], ['Distanze', 'OpenRouteService, profilo mezzi pesanti'], ['Data estrazione', oggi()]
      ])).getColumn(1).width = 34;
      var buf = await wb.xlsx.writeBuffer();
      scarica('simulazione_cedi_' + oggi() + '.xlsx', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      msg('File Excel generato.', 'ok');
    }).catch(function () {});
  });

  /* ============================ configurazione ============================ */
  $('btnParam').addEventListener('click', function () {
    esegui(async function () {
      var p = C.validaParametri({
        euro_km: C.num($('pEuroKm').value, 'tariffa €/km'), km_fatturati: $('pKmFatt').value,
        capacita_pallet: C.num($('pCap').value, 'capacità mezzo'),
        costo_fisso_viaggio: $('pFisso').value.trim() === '' ? 0 : C.num($('pFisso').value, 'costo fisso'),
        settimane_anno: C.num($('pSett').value, 'settimane per anno')
      });
      var gs = C.num($('pGiorni').value, 'giorni lavorativi a settimana');
      if (!(gs >= 1 && gs <= 7)) throw new Error('I giorni lavorativi a settimana devono essere tra 1 e 7.');
      p.giorni_settimana = gs;
      await aggiorna('parametri', 'id', 1, Object.assign({ aggiornato_il: new Date().toISOString() }, p));
      S.P = Object.assign({}, S.P, p); ricalcolaVolumi(); disegnaTutto(); msg('Parametri salvati.', 'ok');
    }).catch(function () {});
  });

  $('sediForm').addEventListener('click', function (ev) {
    if (!ev.target.classList.contains('sSalva')) return;
    var row = ev.target.closest('.sede'), c = row.dataset.codice;
    esegui(async function () {
      var s = S.sedi[c];
      var nome = row.querySelector('.sNome').value.trim() || nomeSede(c);
      var indirizzo = row.querySelector('.sInd').value.trim().replace(/\s+/g, ' ');
      var capTxt = row.querySelector('.sCap').value.trim();
      var cap = capTxt === '' ? null : C.num(capTxt, 'capacità mezzo');
      if (cap !== null && !(cap > 0)) throw new Error('La capacità del mezzo deve essere maggiore di zero.');
      var coordTxt = row.querySelector('.sCoord').value;
      var pos = { lat: null, lng: null, geocodifica: '', etichetta: null };
      if (indirizzo || coordTxt.trim()) {
        // coordinate mostrate ma indirizzo cambiato: si ricalcola dall'indirizzo
        if (coordTxt.trim() && coordTxt.trim() === coordTesto(s) && indirizzo !== s.indirizzo && s.geocodifica !== 'manuale') coordTxt = '';
        pos = await posizione(indirizzo, coordTxt, s);
      }
      var spostata = !vicine(pos, s);
      await aggiorna('sedi', 'codice', c, { nome: nome, indirizzo: indirizzo, lat: pos.lat, lng: pos.lng, capacita_mezzo: cap, geocodifica: pos.geocodifica, aggiornato_il: new Date().toISOString() });
      if (spostata) { await elimina('distanze', 'sede', [c]); S.dist = S.dist.filter(function (d) { return d.sede !== c; }); }
      S.sedi[c] = { codice: c, nome: nome, indirizzo: indirizzo, lat: pos.lat, lng: pos.lng, capacita: cap, geocodifica: pos.geocodifica };
      disegnaTutto();
      var pr = precisione(pos.geocodifica);
      msg('Sede "' + esc(nome) + '" salvata' + (pos.etichetta ? ' — posizione trovata: ' + esc(pos.etichetta) : '') + (pos.lat != null ? ' (' + esc(pr.testo) + ')' : ' senza posizione') +
        (spostata && pos.lat != null ? '. Premere "Aggiorna distanze" nel riepilogo.' : '.'), pr.livello === 'ok' ? 'ok' : 'warn');
    }).catch(function () {});
  });

  $('btnOttimo').addEventListener('click', function () {
    esegui(async function () {
      var o;
      if (conViaggi()) {
        var coord = {};
        S.pv.forEach(function (p) { if (precisione(p.geocodifica).livello !== 'err') coord[p.codice] = { lat: p.lat, lng: p.lng }; });
        o = C.ottimoViaggi(S.viaggi, coord, S.P, S.tariffe, C.tortuosita(S.sedi.ATTUALE, S.dist, mappaPV()));
      } else o = C.weiszfeld(C.pesiOttimo(S.pv, S.P));
      var ind = null;
      try { var r = await ors('inversa', { lat: o.lat, lng: o.lng }); ind = r && r.indirizzo; } catch (e) { /* solo descrittivo */ }
      ind = ind || coordTesto(o);
      await aggiorna('sedi', 'codice', 'OTTIMO', { nome: 'Punto di ottimo', indirizzo: ind, lat: o.lat, lng: o.lng, capacita_mezzo: null, geocodifica: 'calcolato', aggiornato_il: new Date().toISOString() });
      await elimina('distanze', 'sede', ['OTTIMO']);
      S.dist = S.dist.filter(function (d) { return d.sede !== 'OTTIMO'; });
      S.sedi.OTTIMO = { codice: 'OTTIMO', nome: 'Punto di ottimo', indirizzo: ind, lat: o.lat, lng: o.lng, capacita: null, geocodifica: 'calcolato' };
      disegnaTutto();
      var es = await calcolaDistanze(coppieMancanti(S.pv).filter(function (c) { return c.sede === 'OTTIMO'; }), function (k, n) { $('prog').textContent = 'Distanze dall\'ottimo: richiesta ' + k + ' di ' + n; });
      $('prog').textContent = '';
      msg('Punto di ottimo calcolato ' + (conViaggi() ? 'sui ' + S.viaggi.length + ' viaggi reali' : 'su ' + S.pv.length + ' punti vendita') + ': ' + esc(ind) + ' (' + esc(coordTesto(o)) + '). ' +
        (es.errori.length ? es.errori.length + ' distanze non trovate.' : 'Distanze calcolate: vedere il riepilogo.'), es.errori.length ? 'warn' : 'ok');
    }, 'Calcolo del punto di ottimo…').catch(function () {});
  });

  /* ============================ import ============================ */
  /** Legge un file (Excel o CSV) e lo prepara: tipo 'tariffe' per il tariffario, altrimenti riconoscimento automatico. */
  async function leggiEPrepara(file, tipo) {
    var nome = file.name.toLowerCase();
    var prepara = function (righe) { return tipo === 'tariffe' ? C.preparaTariffe(righe) : C.preparaImport(righe); };
    if (/\.(csv|txt)$/.test(nome)) {
      var b = await file.arrayBuffer();
      var testo = new TextDecoder('utf-8').decode(b);
      if (testo.indexOf('�') >= 0) testo = new TextDecoder('windows-1252').decode(b);
      return prepara(C.leggiCSV(testo));
    }
    if (!/\.(xlsx|xlsm|xls)$/.test(nome)) throw new Error('Formato non riconosciuto: usare .xlsx, .xls o .csv.');
    var buf = await file.arrayBuffer();
    if (window.Worker && !CFG.SENZA_WORKER) {
      return await new Promise(function (ok, ko) {
        var w;
        try { w = new Worker('js/lettore-worker.js?v=6'); } catch (e) { ko(e); return; }
        w.onmessage = function (e) { w.terminate(); if (e.data.ok) ok(e.data.risultato); else ko(new Error(e.data.errore)); };
        w.onerror = function (e) { w.terminate(); ko(new Error('Lettura del file non riuscita' + (e && e.message ? ': ' + e.message : ''))); };
        w.postMessage({ buffer: buf, tipo: tipo || '' }, [buf]);
      });
    }
    return prepara(C.righeDaExcel(window.XLSX, new Uint8Array(buf)));
  }

  function csvProblemi(lista) {
    return '﻿' + [['Riga', 'Codice', 'Problema']].concat(lista.map(function (s) { return [s.riga, s.codice, s.motivo]; }))
      .map(function (r) { return r.map(function (v) { v = String(v == null ? '' : v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(';'); }).join('\r\n');
  }

  $('fileImport').addEventListener('change', function () {
    var f = this.files && this.files[0]; if (!f) return;
    var input = this;
    esegui(async function () {
      var prep = await leggiEPrepara(f);
      S.importPronto = prep;
      var nuovi = prep.validi.filter(function (v) { return !trovaPV(v.codice); }).length;
      var giorn = prep.tipo === 'giornaliero';
      var h = '<h3>' + esc(f.name) + '</h3>';
      if (prep.tipo === 'viaggi') {
        // dai viaggi si aggiungono solo i clienti non ancora presenti; quelli esistenti restano come sono
        prep.validi = prep.validi.filter(function (v) { return !trovaPV(v.codice); });
        var nCli = prep.viaggi.reduce(function (s, v) { return s + v.clienti.length; }, 0);
        var conCap = prep.viaggi.filter(function (v) { return v.capPallet > 0; });
        var sat = conCap.reduce(function (s, v) { return s + v.clienti.reduce(function (a, c) { return a + c.occ; }, 0) / v.capPallet; }, 0) / (conCap.length || 1);
        var esist = S.viaggi.filter(function (v) { return v.data >= prep.dal && v.data <= prep.al; }).length;
        h += '<p><b>Viaggi reali</b>: ' + prep.viaggi.length + ' viaggi dal ' + esc(prep.dal) + ' al ' + esc(prep.al) + ', ' + fmt(nCli / prep.viaggi.length, 1) + ' clienti per viaggio in media, ' +
          'saturazione media dei mezzi ' + fmt(sat * 100, 0) + '%. Clienti nuovi da geolocalizzare: ' + prep.validi.length + '.' +
          (esist ? ' I ' + esist + ' viaggi già presenti nello stesso periodo verranno sostituiti.' : '') + '</p>' +
          '<p class="muted">Dal file vengono acquisiti solo viaggio, data, giro, vettore, mezzo, clienti e carichi; nessun dato di autisti, targhe o telefoni.</p>' +
          '<div class="scroll"><table><thead><tr><th>Viaggio</th><th>Data</th><th>Giro</th><th>Vettore</th><th>Mezzo</th><th>Clienti</th><th>Carico / capacità</th></tr></thead><tbody>' +
          prep.viaggi.slice(0, 10).map(function (v) {
            var occ = v.clienti.reduce(function (a, c) { return a + c.occ; }, 0);
            return '<tr><td>' + esc(v.id) + '</td><td>' + esc(v.data) + '</td><td>' + esc(v.giro) + '</td><td class="testo">' + esc(v.vettore) + '</td><td>' + esc(v.mezzo) + '</td><td class="testo">' +
              esc(v.clienti.map(function (c) { return c.pv; }).join(', ')) + '</td><td>' + fmt(occ, 1) + (v.capPallet ? ' / ' + fmt(v.capPallet, 0) : '') + '</td></tr>';
          }).join('') + '</tbody></table></div>' + (prep.viaggi.length > 10 ? '<p class="muted">… e altri ' + (prep.viaggi.length - 10) + ' viaggi.</p>' : '') +
          '<button class="btn" id="btnConfermaImport">Importa ' + prep.viaggi.length + ' viaggi</button>';
        prep.validi.forEach(function (v) { prep.avvisi.push({ riga: v.riga, codice: v.codice, motivo: 'cliente non presente in anagrafica: verrà aggiunto (' + v.nome + ', ' + v.indirizzo + ')' }); });
      } else if (giorn) {
        var perPV = {};
        prep.carichi.forEach(function (c) { var x = perPV[c.pv] = perPV[c.pv] || { giorni: {}, colli: 0 }; x.giorni[c.data] = true; x.colli += c.colli; });
        prep.validi.forEach(function (v) { var x = perPV[v.codice]; v.nGiorni = x ? Object.keys(x.giorni).length : 0; v.colli = x ? x.colli : 0; });
        h += '<p><b>Carichi giornalieri</b>: ' + prep.validi.length + ' punti vendita (' + nuovi + ' nuovi), ' + prep.carichi.length + ' righe di carico, ' +
          prep.date.length + ' giorni (' + esc(prep.date[0] || '') + ' – ' + esc(prep.date[prep.date.length - 1] || '') + '), reparti: ' + prep.reparti.map(esc).join(', ') + '.</p>' +
          '<label style="color:inherit"><input type="checkbox" id="chkSostituisci" checked style="width:auto"> Sostituisci tutti i carichi giornalieri già presenti</label>';
      } else {
        h += '<p>' + prep.validi.length + ' righe valide (' + nuovi + ' nuovi punti vendita, ' + (prep.validi.length - nuovi) + ' aggiornamenti) · ' + prep.scartati.length + ' righe scartate.</p>';
      }
      if (prep.validi.length && prep.tipo !== 'viaggi') {
        h += '<div class="scroll"><table><thead><tr><th>Riga</th><th>Codice</th><th>Nome</th><th>Indirizzo</th>' +
          (giorn ? '<th>Giorni con carico</th><th>Colli totali</th>' : '<th>Pallet/sett.</th><th>Consegne/sett.</th>') + '</tr></thead><tbody>' +
          prep.validi.slice(0, 10).map(function (v) {
            return '<tr><td>' + v.riga + '</td><td>' + esc(v.codice) + '</td><td class="testo">' + esc(v.nome) + '</td><td class="testo">' + esc(v.indirizzo || coordTesto(v.pos)) + '</td>' +
              (giorn ? '<td>' + v.nGiorni + '</td><td>' + fmt(v.colli, 0) + '</td>' : '<td>' + fmt(v.pallet, 1) + '</td><td>' + fmt(v.consegne, 1) + '</td>') + '</tr>';
          }).join('') +
          '</tbody></table></div>' + (prep.validi.length > 10 ? '<p class="muted">… e altre ' + (prep.validi.length - 10) + ' righe.</p>' : '') +
          '<button class="btn" id="btnConfermaImport">Importa ' + prep.validi.length + ' punti vendita</button>';
      }
      if (prep.fuoriPerimetro && prep.fuoriPerimetro.clienti.length) {
        h += '<p class="muted">Esclusi perché fuori perimetro (Campania): ' + prep.fuoriPerimetro.clienti.length + ' punti vendita (' + prep.fuoriPerimetro.clienti.map(esc).join(', ') + ')' +
          (prep.fuoriPerimetro.righe ? ', ' + prep.fuoriPerimetro.righe + ' righe' : '') + '.</p>';
      }
      var segn = prep.scartati.concat(prep.avvisi || []);
      prep.scartati = segn;
      if (segn.length) {
        h += '<h3 class="avviso">' + (prep.tipo !== 'anagrafica' ? 'Segnalazioni (' + segn.length + ')' : 'Righe scartate') + '</h3><div class="scroll"><table><tbody>' +
          segn.slice(0, 20).map(function (s) { return '<tr><td>Riga ' + s.riga + '</td><td>' + esc(s.codice) + '</td><td class="testo">' + esc(s.motivo) + '</td></tr>'; }).join('') +
          '</tbody></table></div>' + (segn.length > 20 ? '<p class="muted">… e altre ' + (segn.length - 20) + '.</p>' : '') + '<button class="btn sec" id="btnScarti">Scarica elenco (CSV)</button>';
      }
      $('anteprima').innerHTML = h;
      msg('File letto: controllare l\'anteprima e confermare l\'import.', 'info');
    }).catch(function () {}).then(function () { input.value = ''; });
  });

  $('anteprima').addEventListener('click', function (ev) {
    if (ev.target.id === 'btnScarti' || ev.target.id === 'btnProblemi') {
      var lista = ev.target.id === 'btnScarti' ? S.importPronto.scartati : S.importProblemi;
      scarica('problemi_import_' + oggi() + '.csv', new Blob([csvProblemi(lista)], { type: 'text/csv;charset=utf-8' }));
      return;
    }
    if (ev.target.id !== 'btnConfermaImport') return;
    var prep = S.importPronto;
    var sostituisci = $('chkSostituisci') ? $('chkSostituisci').checked : false;
    esegui(async function () {
      var pronti = [], problemi = [], nGeo = 0;
      for (var i = 0; i < prep.validi.length; i++) {
        var v = prep.validi[i], es = trovaPV(v.codice), pos;
        $('prog').textContent = '';
        msg('Import in corso: ' + (i + 1) + ' di ' + prep.validi.length + '…', 'info');
        try {
          var serveGeo = !v.pos && !(es && es.lat != null && es.indirizzo === v.indirizzo && es.geocodifica !== 'manuale');
          if (serveGeo && nGeo++ > 0) await pausa(PAUSA_GEOCODIFICA_MS);
          pos = await posizione(v.indirizzo, v.pos ? coordTesto(v.pos) : '', es);
        } catch (e) {
          if (/non raggiungibile|ORS_API_KEY/.test(e.message)) throw e;
          problemi.push({ riga: v.riga, codice: v.codice, motivo: e.message }); continue;
        }
        var pv = { codice: v.codice, nome: v.nome, indirizzo: v.indirizzo || coordTesto(v.pos), lat: pos.lat, lng: pos.lng,
          pallet: prep.tipo === 'giornaliero' ? (es ? es.pallet : null) : v.pallet, consegne: prep.tipo === 'giornaliero' ? (es ? es.consegne : null) : v.consegne,
          geocodifica: pos.geocodifica, carico: es ? es.carico : null, haCarichi: es ? es.haCarichi : false };
        if (precisione(pv.geocodifica).livello !== 'ok') problemi.push({ riga: v.riga, codice: v.codice, motivo: 'posizione approssimata (' + precisione(pv.geocodifica).testo + ')' + (pos.etichetta ? ': ' + pos.etichetta : '') });
        pronti.push(pv);
        if (pronti.length % 50 === 0) await salvaImport(pronti.slice(-50));
      }
      await salvaImport(pronti.slice(pronti.length - pronti.length % 50)); // ultimi non ancora salvati
      var nCarichi = 0, nViaggi = 0, scartatiViaggi = 0;
      if (prep.tipo === 'viaggi') {
        msg('Salvataggio dei viaggi…', 'info');
        var rv = await sb.from('viaggi').delete().gte('data', prep.dal).lte('data', prep.al);
        if (rv.error) throw errDb(rv.error);
        var esistentiV = {}; S.pv.forEach(function (p) { esistentiV[p.codice] = true; });
        var righeV = [], righeC = [];
        prep.viaggi.forEach(function (v) {
          var cl = v.clienti.filter(function (c) { return esistentiV[c.pv]; });
          if (cl.length < v.clienti.length) scartatiViaggi++;
          if (!cl.length) return;
          righeV.push({ id: v.id, data: v.data, giro: v.giro, vettore: v.vettore, mezzo: v.mezzo, cap_pallet: v.capPallet, cap_roll: v.capRoll });
          cl.forEach(function (c) { righeC.push({ viaggio: v.id, pv: c.pv, occ: Math.round(c.occ * 1000) / 1000, colli: c.colli, km_zona: c.kmZona }); });
        });
        await upsert('viaggi', righeV, 'id');
        await upsert('viaggi_clienti', righeC, 'viaggio,pv');
        nViaggi = righeV.length;
        if (scartatiViaggi) problemi.push({ riga: '', codice: '', motivo: scartatiViaggi + ' viaggi con almeno un cliente non geolocalizzato: quel cliente è escluso dal calcolo del viaggio' });
        await caricaDati();
      }
      if (prep.tipo === 'giornaliero') {
        msg('Salvataggio dei carichi giornalieri…', 'info');
        if (sostituisci) { var rr = await sb.from('carichi').delete().gte('data', '1900-01-01'); if (rr.error) throw errDb(rr.error); }
        var esistenti = {}; S.pv.forEach(function (p) { esistenti[p.codice] = true; });
        var carichi = prep.carichi.filter(function (c) { return esistenti[c.pv]; });
        await upsert('carichi', carichi, 'pv,data,reparto');
        await upsert('reparti', prep.reparti.map(function (r) { return { reparto: r }; }), 'reparto', true);
        nCarichi = carichi.length;
        await caricaDati();
      }
      S.importProblemi = problemi.concat(prep.tipo === 'giornaliero' ? (prep.avvisi || []) : []);
      if (prep.tipo === 'viaggi') S.importProblemi = problemi;
      problemi = S.importProblemi;
      disegnaTutto();
      var h = '<p><b>Import completato:</b> ' + (nViaggi ? nViaggi + ' viaggi salvati, ' + pronti.length + ' nuovi clienti' : pronti.length + ' punti vendita salvati') + (nCarichi ? ', ' + nCarichi + ' righe di carico' : '') + (problemi.length ? ', ' + problemi.length + ' segnalazioni.' : '.') + '</p>';
      if (S.vol && S.vol.repartiSenzaFattore.length) h += '<div class="alert warn">Inserire i fattori colli → pallet (sezione sopra) per: ' + S.vol.repartiSenzaFattore.map(esc).join(', ') + '.</div>';
      if (problemi.length) {
        h += '<div class="scroll"><table><tbody>' + problemi.slice(0, 30).map(function (s) { return '<tr><td>Riga ' + s.riga + '</td><td>' + esc(s.codice) + '</td><td class="testo">' + esc(s.motivo) + '</td></tr>'; }).join('') +
          '</tbody></table></div><button class="btn sec" id="btnProblemi">Scarica segnalazioni (CSV)</button>';
      }
      $('anteprima').innerHTML = h;
      S.importPronto = null;
      msg('Import completato. Ora premere "Aggiorna distanze" nella scheda Riepilogo.', problemi.length ? 'warn' : 'ok');
    }, 'Import in corso…').catch(function () {});
  });

  async function salvaImport(lista) {
    if (!lista.length) return;
    var spostati = lista.filter(function (p) { var e = trovaPV(p.codice); return e && !vicine(p, e); }).map(function (p) { return p.codice; });
    await upsert('punti_vendita', lista.map(aDbPV), 'codice');
    if (spostati.length) { await elimina('distanze', 'pv', spostati); S.dist = S.dist.filter(function (d) { return spostati.indexOf(d.pv) < 0; }); }
    var codici = lista.map(function (p) { return p.codice; });
    S.pv = S.pv.filter(function (x) { return codici.indexOf(x.codice) < 0; }).concat(lista); ordinaPV();
  }

  /* ============================ accesso ============================ */
  async function entra(sessione) {
    $('utenteEmail').textContent = sessione.user && sessione.user.email || '';
    $('utente').hidden = false; $('nav').hidden = false;
    mostraScheda('pv');
    await esegui(async function () { await caricaDati(); disegnaTutto(); msg(''); }, 'Caricamento dati…');
  }
  function esci() { $('utente').hidden = true; $('nav').hidden = true; S.pv = []; S.dist = []; mostraScheda('login'); }

  $('formLogin').addEventListener('submit', function (ev) {
    ev.preventDefault();
    esegui(async function () {
      var r = await sb.auth.signInWithPassword({ email: $('loginEmail').value.trim(), password: $('loginPwd').value });
      if (r.error) throw new Error(/invalid/i.test(r.error.message) ? 'Email o password non corrette.' : r.error.message);
      $('loginPwd').value = '';
      return r.data.session;
    }, 'Accesso in corso…').then(entra).catch(function () {});
  });
  $('btnEsci').addEventListener('click', function () { sb.auth.signOut().then(esci, esci); msg(''); });
  $('btnRicarica').addEventListener('click', function () {
    esegui(async function () { await caricaDati(); disegnaTutto(); if (pvCorrente && trovaPV(pvCorrente.codice)) disegnaConfronto(trovaPV(pvCorrente.codice)); msg('Dati aggiornati.', 'ok'); }).catch(function () {});
  });

  async function avvio() {
    if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) { msg('Configurazione mancante: compilare js/config.js con URL e chiave anon di Supabase.', 'err'); return; }
    if (!window.supabase || !window.ExcelJS || !C) { msg('Librerie non caricate: verificare la cartella js/vendor.', 'err'); return; }
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    window.__simulatore = { stato: S, sb: sb }; // per diagnostica dalla console
    var r = await sb.auth.getSession();
    if (r.data && r.data.session) { await entra(r.data.session).catch(function () {}); }
    else mostraScheda('login');
    sb.auth.onAuthStateChange(function (evento) { if (evento === 'SIGNED_OUT') esci(); });
  }
  avvio();
})();
