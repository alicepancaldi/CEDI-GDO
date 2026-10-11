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
  var S = { P: null, sedi: {}, pv: [], dist: [], carichi: [], reparti: {}, vol: null, ultimiErroriDist: [], importPronto: null };

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
    borough: ['solo frazione: verificare', 'warn'], county: ['solo provincia: da correggere', 'err'],
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
      leggiTutto('carichi', ['pv', 'data', 'reparto']), leggiTutto('reparti', ['reparto'])]);
    if (!r[0].length) throw new Error('Tabella "parametri" vuota: eseguire supabase/schema.sql.');
    var p = r[0][0];
    S.P = { euro_km: Number(p.euro_km), km_fatturati: p.km_fatturati, capacita_pallet: Number(p.capacita_pallet), costo_fisso_viaggio: Number(p.costo_fisso_viaggio),
      settimane_anno: Number(p.settimane_anno), giorni_settimana: p.giorni_settimana == null ? 6 : Number(p.giorni_settimana) };
    S.sedi = {};
    r[1].forEach(function (s) {
      S.sedi[s.codice] = { codice: s.codice, nome: s.nome, indirizzo: s.indirizzo || '', lat: s.lat == null ? null : Number(s.lat), lng: s.lng == null ? null : Number(s.lng),
        capacita: s.capacita_mezzo == null ? null : Number(s.capacita_mezzo), geocodifica: s.geocodifica || '' };
    });
    C.CODICI_SEDI.forEach(function (c) { if (!S.sedi[c]) throw new Error('Sede ' + c + ' mancante: eseguire supabase/schema.sql.'); });
    S.pv = r[2].map(daDbPV); ordinaPV();
    S.dist = r[3].map(function (d) { return { sede: d.sede, pv: String(d.pv), km: Number(d.km), minuti: Number(d.minuti), chiave: d.chiave }; });
    S.carichi = r[4].map(function (c) { return { pv: String(c.pv), data: String(c.data).slice(0, 10), reparto: c.reparto, colli: Number(c.colli) }; });
    S.reparti = {};
    r[5].forEach(function (x) { S.reparti[x.reparto] = x.colli_per_pallet == null ? null : Number(x.colli_per_pallet); });
    S.carichi.forEach(function (c) { if (!(c.reparto in S.reparti)) S.reparti[c.reparto] = null; });
    ricalcolaVolumi();
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
    return { lat: g.lat, lng: g.lng, geocodifica: g.livello || '', etichetta: g.indirizzo };
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
      var esistente = trovaPV(codice);
      var conCarichi = esistente && esistente.haCarichi;
      var pTxt = $('pvPallet').value.trim(), cTxt = $('pvConsegne').value.trim();
      var pallet = conCarichi && pTxt === '' ? null : C.num(pTxt, 'pallet/settimana');
      var consegne = conCarichi && cTxt === '' ? null : C.num(cTxt, 'consegne/settimana');
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

  /* ============================ maschera 2 ============================ */
  function disegnaRiepilogo() {
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

  function datiEstrazione() { return C.estrazione(S.P, S.sedi, C.tabella(S.P, S.sedi, S.pv, S.dist)); }
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
      foglio('Riepilogo', d.intestazioneRiepilogo, d.riepilogo, [null, null, '0.0', '#,##0', '#,##0', '#,##0', '0.0', '#,##0']);
      foglio('Dettaglio', d.intestazione, d.righe, [null, null, null, '0.0', '0.0', '0.0', '0.0', '#,##0.00', '#,##0', '#,##0', '0.0']);
      foglio('Parametri', ['Parametro', 'Valore'], [
        ['Tariffa €/km', S.P.euro_km], ['Km fatturati', S.P.km_fatturati === 'AR' ? 'andata e ritorno' : 'solo andata'],
        ['Capacità mezzo standard (pallet)', S.P.capacita_pallet], ['Costo fisso per viaggio €', S.P.costo_fisso_viaggio],
        ['Settimane operative/anno', S.P.settimane_anno], ['Distanze', 'OpenRouteService, profilo mezzi pesanti'], ['Data estrazione', oggi()]
      ]).getColumn(1).width = 34;
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
      S.P = p; ricalcolaVolumi(); disegnaTutto(); msg('Parametri salvati.', 'ok');
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
      var o = C.weiszfeld(C.pesiOttimo(S.pv, S.P));
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
      msg('Punto di ottimo calcolato su ' + S.pv.length + ' punti vendita: ' + esc(ind) + ' (' + esc(coordTesto(o)) + '). ' +
        (es.errori.length ? es.errori.length + ' distanze non trovate.' : 'Distanze calcolate: vedere il riepilogo.'), es.errori.length ? 'warn' : 'ok');
    }, 'Calcolo del punto di ottimo…').catch(function () {});
  });

  /* ============================ import ============================ */
  function valoreCella(v) {
    if (v == null) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') {
      if (v.richText) return v.richText.map(function (t) { return t.text; }).join('');
      if (v.text !== undefined) return String(v.text);
      if (v.result !== undefined) return valoreCella(v.result);
      if (v.error) return '';
      return String(v);
    }
    return v;
  }

  async function leggiFile(file) {
    var nome = file.name.toLowerCase();
    if (/\.xlsx$/.test(nome)) {
      var wb = new window.ExcelJS.Workbook();
      await wb.xlsx.load(await file.arrayBuffer());
      var ws = wb.worksheets.filter(function (w) { return w.actualRowCount > 0; })[0];
      if (!ws) throw new Error('Il file Excel non contiene dati.');
      var righe = [];
      ws.eachRow({ includeEmpty: true }, function (row, n) {
        var r = [];
        for (var c = 1; c <= ws.columnCount; c++) r.push(valoreCella(row.getCell(c).value));
        righe[n - 1] = r;
      });
      for (var i = 0; i < righe.length; i++) if (!righe[i]) righe[i] = [];
      return righe;
    }
    if (/\.(csv|txt)$/.test(nome)) {
      var buf = await file.arrayBuffer();
      var testo = new TextDecoder('utf-8').decode(buf);
      if (testo.indexOf('�') >= 0) testo = new TextDecoder('windows-1252').decode(buf);
      return C.leggiCSV(testo);
    }
    if (/\.xls$/.test(nome)) throw new Error('Formato .xls non supportato: salvare il file come .xlsx o .csv.');
    throw new Error('Formato non riconosciuto: usare .xlsx o .csv.');
  }

  function csvProblemi(lista) {
    return '﻿' + [['Riga', 'Codice', 'Problema']].concat(lista.map(function (s) { return [s.riga, s.codice, s.motivo]; }))
      .map(function (r) { return r.map(function (v) { v = String(v == null ? '' : v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(';'); }).join('\r\n');
  }

  $('fileImport').addEventListener('change', function () {
    var f = this.files && this.files[0]; if (!f) return;
    var input = this;
    esegui(async function () {
      var righe = await leggiFile(f);
      var prep = C.preparaImport(righe);
      S.importPronto = prep;
      var nuovi = prep.validi.filter(function (v) { return !trovaPV(v.codice); }).length;
      var giorn = prep.tipo === 'giornaliero';
      var h = '<h3>' + esc(f.name) + '</h3>';
      if (giorn) {
        var perPV = {};
        prep.carichi.forEach(function (c) { var x = perPV[c.pv] = perPV[c.pv] || { giorni: {}, colli: 0 }; x.giorni[c.data] = true; x.colli += c.colli; });
        prep.validi.forEach(function (v) { var x = perPV[v.codice]; v.nGiorni = x ? Object.keys(x.giorni).length : 0; v.colli = x ? x.colli : 0; });
        h += '<p><b>Carichi giornalieri</b>: ' + prep.validi.length + ' punti vendita (' + nuovi + ' nuovi), ' + prep.carichi.length + ' righe di carico, ' +
          prep.date.length + ' giorni (' + esc(prep.date[0] || '') + ' – ' + esc(prep.date[prep.date.length - 1] || '') + '), reparti: ' + prep.reparti.map(esc).join(', ') + '.</p>' +
          '<label style="color:inherit"><input type="checkbox" id="chkSostituisci" checked style="width:auto"> Sostituisci tutti i carichi giornalieri già presenti</label>';
      } else {
        h += '<p>' + prep.validi.length + ' righe valide (' + nuovi + ' nuovi punti vendita, ' + (prep.validi.length - nuovi) + ' aggiornamenti) · ' + prep.scartati.length + ' righe scartate.</p>';
      }
      if (prep.validi.length) {
        h += '<div class="scroll"><table><thead><tr><th>Riga</th><th>Codice</th><th>Nome</th><th>Indirizzo</th>' +
          (giorn ? '<th>Giorni con carico</th><th>Colli totali</th>' : '<th>Pallet/sett.</th><th>Consegne/sett.</th>') + '</tr></thead><tbody>' +
          prep.validi.slice(0, 10).map(function (v) {
            return '<tr><td>' + v.riga + '</td><td>' + esc(v.codice) + '</td><td class="testo">' + esc(v.nome) + '</td><td class="testo">' + esc(v.indirizzo || coordTesto(v.pos)) + '</td>' +
              (giorn ? '<td>' + v.nGiorni + '</td><td>' + fmt(v.colli, 0) + '</td>' : '<td>' + fmt(v.pallet, 1) + '</td><td>' + fmt(v.consegne, 1) + '</td>') + '</tr>';
          }).join('') +
          '</tbody></table></div>' + (prep.validi.length > 10 ? '<p class="muted">… e altre ' + (prep.validi.length - 10) + ' righe.</p>' : '') +
          '<button class="btn" id="btnConfermaImport">Importa ' + prep.validi.length + ' punti vendita</button>';
      }
      var segn = prep.scartati.concat(prep.avvisi || []);
      prep.scartati = segn;
      if (segn.length) {
        h += '<h3 class="avviso">' + (giorn ? 'Segnalazioni (' + segn.length + ')' : 'Righe scartate') + '</h3><div class="scroll"><table><tbody>' +
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
      var nCarichi = 0;
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
      problemi = S.importProblemi;
      disegnaTutto();
      var h = '<p><b>Import completato:</b> ' + pronti.length + ' punti vendita salvati' + (nCarichi ? ', ' + nCarichi + ' righe di carico' : '') + (problemi.length ? ', ' + problemi.length + ' segnalazioni.' : '.') + '</p>';
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
