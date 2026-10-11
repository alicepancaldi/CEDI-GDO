/*
 * Simulatore rilocalizzazione CEDI — modello di calcolo (funzioni pure, senza accesso ai dati)
 *
 *   viaggi per consegna  = ceil( (pallet settimana / consegne settimana) / capacità mezzo )
 *   viaggi settimana     = consegne settimana × viaggi per consegna
 *   km fatturati viaggio = km stradali × 2 (A/R) oppure × 1 (solo andata)
 *   costo viaggio        = km fatturati × €/km + costo fisso per viaggio
 *   costo anno           = viaggi settimana × costo viaggio × settimane operative
 *
 * Punto di ottimo: mediana geometrica pesata (problema di Weber) con l'algoritmo di Weiszfeld
 * e la correzione di Vardi-Zhang; peso di ogni PV = € per km di distanza dal CEDI.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Calcolo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CODICI_SEDI = ['ATTUALE', 'OPZ1', 'OPZ2', 'OPZ3', 'OTTIMO'];

  /** Numero da input italiano o inglese: "1,30", "1.30", "1.234,56", 12. */
  function num(v, nome) {
    if (typeof v === 'number') { if (!isFinite(v)) throw new Error('Valore non valido per ' + nome); return v; }
    var s = String(v === undefined || v === null ? '' : v).trim().replace(/\s/g, '').replace(/€/g, '');
    var norm = /,\d*$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s;
    var n = Number(norm);
    if (s === '' || isNaN(n) || !isFinite(n)) throw new Error('Valore numerico non valido per ' + nome + ': "' + v + '"');
    return n;
  }

  function validaParametri(p) {
    if (!(p.euro_km > 0)) throw new Error('La tariffa €/km deve essere maggiore di zero.');
    if (['AR', 'A'].indexOf(p.km_fatturati) < 0) throw new Error('Km fatturati: scegliere andata e ritorno o solo andata.');
    if (!(p.capacita_pallet > 0)) throw new Error('La capacità del mezzo deve essere maggiore di zero.');
    if (!(p.costo_fisso_viaggio >= 0)) throw new Error('Il costo fisso per viaggio non può essere negativo.');
    if (!(p.settimane_anno > 0 && p.settimane_anno <= 53)) throw new Error('Le settimane operative devono essere tra 1 e 53.');
    return p;
  }

  /** "44.49, 11.34" oppure "44,49 11,34" -> {lat, lng}; stringa vuota -> null */
  function leggiCoordinate(testo) {
    var s = String(testo || '').trim();
    if (!s) return null;
    var m = s.match(/^\s*(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)\s*$/);
    if (!m) throw new Error('Coordinate non valide: usare il formato "44.4949, 11.3426"');
    var lat = Number(m[1].replace(',', '.')), lng = Number(m[2].replace(',', '.'));
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error('Coordinate fuori scala');
    if (lat > 35 && lat < 48 && lng > 6 && lng < 19) return { lat: lat, lng: lng };
    if (lng > 35 && lng < 48 && lat > 6 && lat < 19) return { lat: lng, lng: lat }; // invertite
    return { lat: lat, lng: lng };
  }

  function chiaveCoord(sede, pv) {
    return [sede.lat, sede.lng, pv.lat, pv.lng].map(function (x) { return Number(x).toFixed(6); }).join('|');
  }

  /** Volumi del PV: da carichi giornalieri (se presenti) oppure da pallet e consegne a settimana. null = non calcolabili. */
  function volumePV(pv, cap) {
    if (pv.carico) {
      var c = pv.carico, viaggi = 0, pallet = 0;
      c.giorni.forEach(function (L) { if (L > 0) { viaggi += Math.ceil(L / cap - 1e-9); pallet += L; } });
      return { viaggiSett: viaggi / c.settimane, palletSett: pallet / c.settimane, consegneSett: c.giorni.filter(function (L) { return L > 0; }).length / c.settimane };
    }
    if (pv.pallet > 0 && pv.consegne > 0) {
      var palletConsegna = pv.pallet / pv.consegne;
      return { viaggiSett: pv.consegne * Math.ceil(palletConsegna / cap - 1e-9), palletSett: pv.pallet, consegneSett: pv.consegne };
    }
    return null;
  }

  function metriche(pv, sede, dist, P) {
    var cap = sede && sede.capacita > 0 ? sede.capacita : P.capacita_pallet;
    var vol = volumePV(pv, cap);
    if (!vol) return null;
    var viaggiSett = vol.viaggiSett;
    var kmFattViaggio = dist.km * (P.km_fatturati === 'AR' ? 2 : 1);
    var costoViaggio = kmFattViaggio * P.euro_km + P.costo_fisso_viaggio;
    var costoSett = viaggiSett * costoViaggio;
    return {
      km: dist.km, minuti: dist.minuti, viaggiSett: viaggiSett, kmSett: viaggiSett * kmFattViaggio,
      palletSett: vol.palletSett, consegneSett: vol.consegneSett,
      costoViaggio: costoViaggio, costoSett: costoSett, costoAnno: costoSett * P.settimane_anno
    };
  }

  function delta(m, rif) {
    if (!m || !rif) return null;
    return {
      km: m.km - rif.km, viaggiSett: m.viaggiSett - rif.viaggiSett,
      costoSett: m.costoSett - rif.costoSett, costoAnno: m.costoAnno - rif.costoAnno,
      pct: rif.costoAnno ? (m.costoAnno - rif.costoAnno) / rif.costoAnno * 100 : null
    };
  }

  /** punti: [{lat, lng, w}] -> {lat, lng, iterazioni}. Proiezione equirettangolare locale in km. */
  function weiszfeld(punti) {
    var validi = punti.filter(function (p) { return p.w > 0 && isFinite(p.lat) && isFinite(p.lng); });
    var W = validi.reduce(function (s, p) { return s + p.w; }, 0);
    if (!validi.length || !(W > 0)) throw new Error('Servono punti vendita con coordinate e volumi validi.');
    var lat0 = validi.reduce(function (s, p) { return s + p.w * p.lat; }, 0) / W;
    var lng0 = validi.reduce(function (s, p) { return s + p.w * p.lng; }, 0) / W;
    var kx = 111.320 * Math.cos(lat0 * Math.PI / 180), ky = 110.574;
    var P = validi.map(function (p) { return { x: (p.lng - lng0) * kx, y: (p.lat - lat0) * ky, w: p.w }; });
    var x = 0, y = 0, it = 0;
    for (; it < 5000; it++) {
      var nx = 0, ny = 0, den = 0, wCoinc = 0;
      for (var i = 0; i < P.length; i++) {
        var p = P[i], d = Math.hypot(x - p.x, y - p.y);
        if (d < 1e-9) { wCoinc += p.w; continue; }
        nx += p.w * p.x / d; ny += p.w * p.y / d; den += p.w / d;
      }
      if (den === 0) break;
      var tx = nx / den, ty = ny / den;
      if (wCoinc > 0) {
        var r = Math.hypot(nx - x * den, ny - y * den);
        if (r <= wCoinc) break;
        var a = wCoinc / r;
        tx = (1 - a) * tx + a * x; ty = (1 - a) * ty + a * y;
      }
      var passo = Math.hypot(tx - x, ty - y);
      x = tx; y = ty;
      if (passo < 1e-7) break;
    }
    return { lat: lat0 + y / ky, lng: lng0 + x / kx, iterazioni: it };
  }

  /** Pesi per l'ottimo: € per km di distanza CEDI-PV (il costo fisso per viaggio non dipende dalla sede). */
  function pesiOttimo(pvLista, P) {
    var kmFatt = P.km_fatturati === 'AR' ? 2 : 1;
    return pvLista.filter(function (p) { return p.lat !== null && p.lat !== undefined; }).map(function (p) {
      var m = metriche(p, null, { km: 1, minuti: 0 }, P);
      return m ? { lat: p.lat, lng: p.lng, w: m.viaggiSett * kmFatt * P.euro_km } : null;
    }).filter(Boolean);
  }

  /** Tabella completa: metriche per PV e sede, totali, distanze mancanti. */
  function tabella(P, sedi, pvLista, distanze) {
    var mappa = {};
    distanze.forEach(function (d) { mappa[d.sede + '#' + d.pv] = d; });
    var attive = CODICI_SEDI.filter(function (c) { return sedi[c] && sedi[c].lat !== null && sedi[c].lat !== undefined; });
    var tot = {};
    attive.forEach(function (c) { tot[c] = { viaggiSett: 0, kmSett: 0, costoSett: 0, costoAnno: 0, mancanti: 0 }; });
    var senzaVolumi = pvLista.filter(function (pv) { return !volumePV(pv, P.capacita_pallet); });
    var righe = pvLista.filter(function (pv) { return senzaVolumi.indexOf(pv) < 0; }).map(function (pv) {
      var m = {};
      attive.forEach(function (c) {
        var d = mappa[c + '#' + pv.codice];
        var valida = d && d.chiave === chiaveCoord(sedi[c], pv);
        m[c] = valida ? metriche(pv, sedi[c], d, P) : null;
        if (!m[c]) { tot[c].mancanti++; return; }
        ['viaggiSett', 'kmSett', 'costoSett', 'costoAnno'].forEach(function (k) { tot[c][k] += m[c][k]; });
      });
      return { pv: pv, m: m };
    });
    return { attive: attive, righe: righe, tot: tot, senzaVolumi: senzaVolumi };
  }

  function riepilogo(P, sedi, t) {
    var rif = t.tot.ATTUALE, ott = t.tot.OTTIMO;
    return t.attive.map(function (c) {
      var x = t.tot[c];
      return {
        codice: c, nome: sedi[c].nome, indirizzo: sedi[c].indirizzo,
        viaggiSett: x.viaggiSett, kmSett: x.kmSett, costoSett: x.costoSett, costoAnno: x.costoAnno, mancanti: x.mancanti,
        deltaAnno: rif && c !== 'ATTUALE' ? x.costoAnno - rif.costoAnno : null,
        deltaPct: rif && c !== 'ATTUALE' && rif.costoAnno ? (x.costoAnno - rif.costoAnno) / rif.costoAnno * 100 : null,
        deltaViaggi: rif && c !== 'ATTUALE' ? x.viaggiSett - rif.viaggiSett : null,
        sopraOttimo: ott && c !== 'OTTIMO' ? x.costoAnno - ott.costoAnno : null
      };
    });
  }

  function arr(x, dec) { var f = Math.pow(10, dec); return Math.round(x * f) / f; }

  /** Dati di estrazione (solo grandezze che incidono sul costo). */
  function estrazione(P, sedi, t) {
    var mancanti = t.attive.reduce(function (s, c) { return s + t.tot[c].mancanti; }, 0);
    if (mancanti) throw new Error('Mancano ' + mancanti + ' distanze: premere "Aggiorna distanze" prima di estrarre.');
    var intest = ['Codice PV', 'Nome PV', 'Sede', 'Km (andata)', 'Δ km vs attuale', 'Viaggi/settimana', 'Δ viaggi/settimana', 'Costo/viaggio €', 'Costo/anno €', 'Δ costo/anno €', 'Δ %'];
    var righe = [];
    t.righe.forEach(function (r) {
      var a = r.m.ATTUALE;
      t.attive.forEach(function (c) {
        var m = r.m[c], d = c === 'ATTUALE' ? null : delta(m, a);
        righe.push([r.pv.codice, r.pv.nome, sedi[c].nome, arr(m.km, 1), d ? arr(d.km, 1) : '', m.viaggiSett, d ? d.viaggiSett : '',
          arr(m.costoViaggio, 2), arr(m.costoAnno, 0), d ? arr(d.costoAnno, 0) : '', d && d.pct !== null ? arr(d.pct, 1) : '']);
      });
    });
    var intestRiep = ['Sede', 'Indirizzo', 'Viaggi/settimana', 'Km fatturati/settimana', 'Costo/anno €', 'Δ costo/anno € vs attuale', 'Δ %', 'Sopra l\'ottimo €/anno'];
    var righeRiep = riepilogo(P, sedi, t).map(function (s) {
      return [s.nome, s.indirizzo, s.viaggiSett, arr(s.kmSett, 0), arr(s.costoAnno, 0),
        s.deltaAnno === null ? '' : arr(s.deltaAnno, 0), s.deltaPct === null ? '' : arr(s.deltaPct, 1),
        s.sopraOttimo === null ? '' : arr(s.sopraOttimo, 0)];
    });
    return { intestazioneRiepilogo: intestRiep, riepilogo: righeRiep, intestazione: intest, righe: righe };
  }

  /** CSV per Excel italiano: separatore ; e virgola decimale, BOM UTF-8. */
  function csv(d) {
    var cella = function (v) {
      var s = typeof v === 'number' ? String(v).replace('.', ',') : String(v === null || v === undefined ? '' : v);
      return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return '﻿' + [d.intestazioneRiepilogo].concat(d.riepilogo, [[]], [d.intestazione], d.righe)
      .map(function (r) { return r.map(cella).join(';'); }).join('\r\n');
  }

  /* ---------- import punti vendita da tabella grezza ---------- */

  var ALIAS = {
    codice: ['codice', 'cod', 'codice pv', 'codicepv', 'cod pv', 'id', 'pv', 'punto vendita', 'codice punto vendita', 'negozio', 'store', 'codcli', 'cod cli', 'codice cliente', 'cliente'],
    nome: ['nome', 'descrizione', 'insegna', 'ragione sociale', 'denominazione', 'nome pv'],
    indirizzo: ['indirizzo', 'indirizzo completo', 'via', 'address'],
    cap: ['cap', 'c.a.p.', 'codice postale'],
    comune: ['comune', 'citta', 'città', 'localita', 'località', 'city'],
    provincia: ['provincia', 'prov', 'pr', 'sigla provincia', 'provincia ric'],
    reparto: ['reparto', 'mag', 'magazzino', 'settore', 'famiglia'],
    data: ['data', 'giorno', 'data consegna', 'data carico'],
    colli: ['colli', 'n colli', 'numero colli', 'quantita', 'qta', 'qta colli'],
    pallet: ['pallet', 'pallet settimana', 'pallet/settimana', 'pallet sett', 'pallet_settimana', 'pallet a settimana', 'volume', 'volume pallet'],
    consegne: ['consegne', 'consegne settimana', 'consegne/settimana', 'consegne_settimana', 'frequenza', 'consegne a settimana', 'n consegne'],
    lat: ['lat', 'latitudine', 'latitude'],
    lng: ['lng', 'lon', 'long', 'longitudine', 'longitude'],
    coordinate: ['coordinate', 'coord', 'lat lng', 'lat,lng']
  };

  function normTitolo(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** Riconosce le colonne dall'intestazione: restituisce {campo: indice}. */
  function mappaColonne(intestazione) {
    var out = {};
    var norm = intestazione.map(normTitolo);
    Object.keys(ALIAS).forEach(function (campo) {
      var alias = ALIAS[campo].map(normTitolo);
      for (var i = 0; i < norm.length; i++) {
        if (alias.indexOf(norm[i]) >= 0 && Object.keys(out).map(function (k) { return out[k]; }).indexOf(i) < 0) { out[campo] = i; return; }
      }
    });
    return out;
  }

  /** Data da cella o intestazione: Date, "2026-03-02", "2026-03-02T00:00:00Z", "02/03/2026" -> "2026-03-02"; altrimenti null. */
  function leggiData(v) {
    if (v instanceof Date || (v && typeof v.toISOString === 'function')) return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
    if (typeof v === 'number' && v > 20000 && v < 80000) { // numero seriale di Excel
      var dt = new Date(Math.round((v - 25569) * 86400000));
      return dt.toISOString().slice(0, 10);
    }
    var s = String(v == null ? '' : v).trim(), m;
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})(T.*)?$/))) return m[1] + '-' + m[2] + '-' + m[3];
    if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/))) {
      var a = m[3].length === 2 ? '20' + m[3] : m[3];
      return a + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
    }
    return null;
  }

  /** Toglie dall'indirizzo le sigle che confondono la geocodifica (S.N., S.N.C., N.C., "ANG. via secondaria"). */
  function pulisciIndirizzo(s) {
    return String(s || '').replace(/\s+/g, ' ').trim()
      .replace(/\s+ANG(\.|\s).*$/i, '')
      .replace(/(^|[\s,])(S\.\s?N\.\s?C\.?|S\.\s?N\.?|N\.\s?C\.?|SNC|SN)(?=$|[\s,])/gi, '$1')
      .replace(/[\s,]+$/, '').replace(/,\s*,/g, ',').replace(/\s+/g, ' ').trim();
  }

  /** Distanza in linea d'aria (km). */
  function distanzaKm(a, b) {
    var R = 6371, t = Math.PI / 180;
    var dl = (b.lat - a.lat) * t, dg = (b.lng - a.lng) * t;
    var h = Math.sin(dl / 2) * Math.sin(dl / 2) + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dg / 2) * Math.sin(dg / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /** Comune dall'indirizzo composto: "VIA X 1, CANOSA DI PUGLIA (BT)" -> "CANOSA DI PUGLIA (BT)"; null se non c'è una virgola. */
  function comuneDaIndirizzo(ind) {
    var parti = String(ind || '').split(',');
    if (parti.length < 2) return null;
    var c = parti[parti.length - 1].replace(/\b\d{5}\b/, '').trim();
    return c && /[A-Za-zÀ-ÿ]/.test(c) && !/^\d/.test(c) ? c : null;
  }

  /** Sigla provincia: dall'indirizzo composto "…, COMUNE (BA)" e dall'etichetta ORS "…, Bari, BA, Italia". */
  function provinciaDaIndirizzo(ind) { var m = String(ind || '').match(/\(([A-Za-z]{2})\)\s*$/); return m ? m[1].toUpperCase() : null; }
  function provinciaDaEtichetta(et) { var m = String(et || '').match(/,\s*([A-Z]{2}),\s*Italia\s*$/); return m ? m[1] : null; }

  /** Comune dall'etichetta ORS: "Via X 4, Cutro, KR, Italia" -> "Cutro"; "…, Comune di Polignano a Mare, BA, Italia" -> "Polignano a Mare". */
  function comuneDaEtichetta(et) {
    var p = String(et || '').split(',').map(function (x) { return x.trim(); });
    if (p.length >= 3 && /^Italia$/i.test(p[p.length - 1]) && /^[A-Z]{2}$/.test(p[p.length - 2])) return p[p.length - 3].replace(/^Comune di\s+/i, '');
    return null;
  }

  function normTesto(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }

  function normReparto(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim() || 'unico'; }

  function componiIndirizzo(v) {
    var indirizzo = pulisciIndirizzo(v('indirizzo'));
    var extra = [v('cap'), v('comune'), v('provincia') ? '(' + v('provincia').toUpperCase() + ')' : ''].filter(Boolean).join(' ');
    var com = v('comune'), cap = v('cap');
    var giaPresente = (cap && indirizzo.indexOf(cap) >= 0) ||
      (com && new RegExp(',\\s*(\\d{5}\\s+)?' + com.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(indirizzo));
    if (extra && !giaPresente) indirizzo = indirizzo ? indirizzo + ', ' + extra : extra;
    return indirizzo;
  }

  /**
   * Carichi giornalieri (colli per reparto) -> volumi in pallet per PV.
   * fattori: {reparto: colli per pallet}. Il periodo vale (giorni con dati) / (giorni lavorativi a settimana) settimane.
   */
  function volumi(carichi, fattori, giorniSettimana) {
    var date = {}, perPV = {}, senzaFattore = {};
    carichi.forEach(function (c) {
      date[c.data] = true;
      var f = fattori[c.reparto];
      var p = perPV[c.pv] = perPV[c.pv] || { giorni: {}, incompleto: false };
      if (!(f > 0)) { senzaFattore[c.reparto] = true; p.incompleto = true; return; }
      p.giorni[c.data] = (p.giorni[c.data] || 0) + c.colli / f;
    });
    var elenco = Object.keys(date).sort();
    var settimane = elenco.length / (giorniSettimana > 0 ? giorniSettimana : 6);
    var out = {};
    Object.keys(perPV).forEach(function (k) {
      var p = perPV[k];
      out[k] = p.incompleto ? null : { giorni: Object.keys(p.giorni).map(function (d) { return p.giorni[d]; }), settimane: settimane };
    });
    return { perPV: out, giorni: elenco.length, settimane: settimane, dal: elenco[0] || null, al: elenco[elenco.length - 1] || null, repartiSenzaFattore: Object.keys(senzaFattore).sort() };
  }

  /** Formato giornaliero: una riga per PV (e reparto) con colonne-data (largo) oppure colonne data + colli (lungo). */
  function preparaGiornaliero(righe, iHdr, col, colonneData) {
    var pv = {}, ordine = [], carichi = {}, scartati = [], avvisi = [];
    righe.slice(iHdr + 1).forEach(function (r, k) {
      var riga = iHdr + k + 2;
      if (!r || r.every(function (c) { return String(c === null || c === undefined ? '' : c).trim() === ''; })) return;
      var v = function (c) { return col[c] === undefined ? '' : String(r[col[c]] === undefined || r[col[c]] === null ? '' : r[col[c]]).trim(); };
      var codice = v('codice');
      if (/^\d+\.0+$/.test(codice)) codice = codice.replace(/\.0+$/, '');
      if (!codice) { scartati.push({ riga: riga, codice: '', motivo: 'codice mancante' }); return; }
      var indirizzo = componiIndirizzo(v);
      if (!pv[codice]) {
        if (!indirizzo) { scartati.push({ riga: riga, codice: codice, motivo: 'indirizzo mancante' }); return; }
        pv[codice] = { riga: riga, codice: codice, nome: v('nome').replace(/\s+/g, ' '), indirizzo: indirizzo, pos: null, pallet: null, consegne: null };
        ordine.push(codice);
      } else if (pv[codice].indirizzo !== indirizzo) {
        avvisi.push({ riga: riga, codice: codice, motivo: 'indirizzo diverso da quello della riga ' + pv[codice].riga + ': usato il primo' });
      }
      var reparto = normReparto(v('reparto'));
      var aggiungi = function (data, valore) {
        var t = String(valore === null || valore === undefined ? '' : valore).trim();
        if (t === '') return;
        var n;
        try { n = num(t, 'colli'); } catch (e) { scartati.push({ riga: riga, codice: codice, motivo: 'quantità non numerica "' + t + '" il ' + data + ' (' + reparto + '): ignorata' }); return; }
        if (n < 0) { scartati.push({ riga: riga, codice: codice, motivo: 'quantità negativa il ' + data + ': ignorata' }); return; }
        if (n === 0) return;
        var chiave = codice + '|' + data + '|' + reparto;
        carichi[chiave] = carichi[chiave] || { pv: codice, data: data, reparto: reparto, colli: 0 };
        carichi[chiave].colli += n;
      };
      if (colonneData.length) colonneData.forEach(function (cd) { aggiungi(cd.data, r[cd.indice]); });
      else {
        var d = leggiData(r[col.data]);
        if (!d) { scartati.push({ riga: riga, codice: codice, motivo: 'data non valida "' + v('data') + '"' }); return; }
        aggiungi(d, r[col.colli]);
      }
    });
    var lista = Object.keys(carichi).map(function (k) { return carichi[k]; });
    var conCarichi = {};
    lista.forEach(function (c) { conCarichi[c.pv] = true; });
    var validi = ordine.map(function (c) { return pv[c]; });
    validi.filter(function (p) { return !conCarichi[p.codice]; }).forEach(function (p) {
      avvisi.push({ riga: p.riga, codice: p.codice, motivo: 'nessun carico nel periodo: il PV viene importato ma non entra nei totali' });
    });
    var date = {}; lista.forEach(function (c) { date[c.data] = true; });
    var reparti = {}; lista.forEach(function (c) { reparti[c.reparto] = true; });
    return { tipo: 'giornaliero', validi: validi, carichi: lista, scartati: scartati, avvisi: avvisi, colonne: col,
      date: Object.keys(date).sort(), reparti: Object.keys(reparti).sort() };
  }

  /* ---------- viaggi reali (estrazione del gestionale di magazzino) ---------- */

  // Solo queste colonne vengono lette: dati di autisti, targhe e telefoni non vengono mai acquisiti.
  var ALIAS_VIAGGI = {
    viaggio: ['numvg', 'n viaggio', 'numero viaggio', 'viaggio', 'id viaggio'],
    data: ['dtv', 'data viaggio', 'data'],
    codice: ['codcli', 'codice cliente', 'cod cli', 'cliente'],
    giro: ['giro'],
    vettore: ['nominativo', 'vettore'],
    mezzo: ['tipomezzo', 'tipo mezzo', 'mezzo'],
    capPallet: ['pallet', 'capacita pallet', 'posti pallet'],
    capRoll: ['roll', 'capacita roll', 'posti roll'],
    occ: ['numito', 'unita equivalenti', 'pallet equivalenti', 'occupazione'],
    colli: ['colli', 'ncol'],
    reparto: ['repcd', 'reparto'],
    nome: ['rs', 'ragione sociale', 'nome'],
    indirizzo: ['ind bc', 'indirizzo consegna', 'indirizzo'],
    cap: ['cap bc', 'cap consegna', 'cap'],
    comune: ['citta bc', 'comune consegna', 'citta', 'comune'],
    provincia: ['prov bc', 'provincia consegna', 'prov', 'provincia'],
    kmZona: ['km gcl', 'km zona']
  };
  var REPARTI_CODICE = { O: 'ortofrutta', F: 'salumi/formaggi', A: 'carne', S: 'surgelati' };

  // Perimetro dello studio: i punti vendita in Campania restano sempre fuori (import, calcoli, estrazioni).
  var PROVINCE_FUORI_PERIMETRO = ['AV', 'BN', 'CE', 'NA', 'SA'];
  function fuoriPerimetro(prov) { return PROVINCE_FUORI_PERIMETRO.indexOf(String(prov || '').trim().toUpperCase()) >= 0; }
  function pvFuoriPerimetro(pv) { return fuoriPerimetro(provinciaDaIndirizzo(pv && pv.indirizzo)); }

  function colonneViaggi(intestazione) {
    var norm = intestazione.map(normTitolo), out = {};
    Object.keys(ALIAS_VIAGGI).forEach(function (campo) {
      var alias = ALIAS_VIAGGI[campo];
      for (var a = 0; a < alias.length; a++) {
        var i = norm.indexOf(normTitolo(alias[a]));       // prima occorrenza (nel gestionale alcune intestazioni sono ripetute)
        if (i >= 0) { out[campo] = i; return; }
      }
    });
    return out;
  }

  function preparaViaggi(righe, iHdr) {
    var col = colonneViaggi(righe[iHdr]);
    var viaggi = {}, ordine = [], anag = {}, ordineAnag = [], scartati = [], avvisi = [], date = {}, fuori = {}, righeFuori = 0;
    var testo = function (r, c) { return col[c] === undefined ? '' : String(r[col[c]] === undefined || r[col[c]] === null ? '' : r[col[c]]).trim(); };
    var numero = function (r, c) { var t = testo(r, c); if (t === '') return null; try { return num(t, c); } catch (e) { return null; } };
    var codiceDa = function (t) { return /^\d+\.0+$/.test(t) ? t.replace(/\.0+$/, '') : t; };
    righe.slice(iHdr + 1).forEach(function (r, k) {
      var riga = iHdr + k + 2;
      if (!r || !r.length) return;
      var id = codiceDa(testo(r, 'viaggio')), pv = codiceDa(testo(r, 'codice'));
      if (!id || !pv) return;                                  // righe senza viaggio o senza cliente: non sono consegne
      var data = leggiData(r[col.data]);
      if (!data) { scartati.push({ riga: riga, codice: pv, motivo: 'data viaggio non valida "' + testo(r, 'data') + '"' }); return; }
      date[data] = true;
      if (fuoriPerimetro(testo(r, 'provincia'))) { fuori[pv] = true; righeFuori++; return; }
      var v = viaggi[id];
      if (!v) {
        v = viaggi[id] = { id: id, data: data, giro: testo(r, 'giro'), vettore: testo(r, 'vettore').replace(/\s+/g, ' '), mezzo: testo(r, 'mezzo'),
          capPallet: numero(r, 'capPallet'), capRoll: numero(r, 'capRoll'), clienti: {} };
        ordine.push(id);
      }
      var c = v.clienti[pv] = v.clienti[pv] || { pv: pv, occ: 0, colli: 0, kmZona: null };
      c.occ += numero(r, 'occ') || 0;
      c.colli += numero(r, 'colli') || 0;
      var kz = numero(r, 'kmZona'); if (kz !== null) c.kmZona = kz;
      if (!anag[pv]) {
        var cap = codiceDa(testo(r, 'cap'));
        var vv = function (campo) { return campo === 'cap' ? cap : testo(r, campo); };
        anag[pv] = { riga: riga, codice: pv, nome: testo(r, 'nome').replace(/\s+/g, ' '), indirizzo: componiIndirizzo(vv), pos: null, pallet: null, consegne: null };
        ordineAnag.push(pv);
      }
    });
    var lista = ordine.map(function (id) {
      var v = viaggi[id];
      v.clienti = Object.keys(v.clienti).map(function (k) { return v.clienti[k]; });
      return v;
    });
    var elencoDate = Object.keys(date).sort();
    return { tipo: 'viaggi', viaggi: lista, validi: ordineAnag.map(function (k) { return anag[k]; }), scartati: scartati, avvisi: avvisi, colonne: col,
      date: elencoDate, dal: elencoDate[0] || null, al: elencoDate[elencoDate.length - 1] || null,
      fuoriPerimetro: { clienti: Object.keys(fuori), righe: righeFuori } };
  }

  /** Esclude dal risultato di un import (giornaliero o anagrafica) i punti vendita fuori perimetro. */
  function togliFuoriPerimetro(res) {
    var fuori = {};
    res.validi = res.validi.filter(function (v) { if (pvFuoriPerimetro(v)) { fuori[v.codice] = true; return false; } return true; });
    var righe = 0;
    if (res.carichi) res.carichi = res.carichi.filter(function (c) { if (fuori[c.pv]) { righe++; return false; } return true; });
    res.fuoriPerimetro = { clienti: Object.keys(fuori), righe: righe };
    return res;
  }

  /* ---------- tariffario ---------- */

  /** Righe del tariffario dell'anno indicato (o del più recente), per mezzo specifico o generico ('*'). */
  function righeTariffa(tariffe, anno, mezzo) {
    if (!tariffe || !tariffe.length) return [];
    var anni = tariffe.map(function (t) { return t.anno; }).filter(function (a, i, x) { return x.indexOf(a) === i; }).sort();
    var a = anno && anni.indexOf(anno) >= 0 ? anno : anni[anni.length - 1];
    var dellAnno = tariffe.filter(function (t) { return t.anno === a; });
    var specifiche = dellAnno.filter(function (t) { return mezzo && t.mezzo && t.mezzo !== '*' && t.mezzo.toUpperCase() === String(mezzo).toUpperCase(); });
    return specifiche.length ? specifiche : dellAnno.filter(function (t) { return !t.mezzo || t.mezzo === '*'; });
  }

  /** Costo di un viaggio di km (già A/R o solo andata secondo i parametri). Senza tariffario: €/km dei parametri. */
  function costoViaggio(km, mezzo, tariffe, P) {
    var righe = righeTariffa(tariffe, P.anno_tariffa, mezzo);
    if (!righe.length) return km * P.euro_km + P.costo_fisso_viaggio;
    var f = righe.filter(function (t) { return km >= (t.km_da || 0) && (t.km_a == null || km < t.km_a); })[0];
    if (!f) f = righe.slice().sort(function (a, b) { return (b.km_da || 0) - (a.km_da || 0); })[0]; // oltre l'ultima fascia: ultima fascia
    return (f.euro_fisso || 0) + (f.euro_km || 0) * km;
  }

  /** Giorni di calendario coperti dai viaggi e fattore per riportare all'anno. */
  function periodoViaggi(viaggi) {
    if (!viaggi.length) return null;
    var dd = viaggi.map(function (v) { return v.data; }).sort();
    var giorni = Math.round((Date.parse(dd[dd.length - 1]) - Date.parse(dd[0])) / 86400000) + 1;
    return { dal: dd[0], al: dd[dd.length - 1], giorni: giorni, fattoreAnno: 365 / giorni };
  }

  /**
   * Ricalcolo dei viaggi reali da ogni sede: km del viaggio = distanza dalla sede al cliente più lontano del giro,
   * × 2 se i km fatturati sono andata e ritorno. Costo da tariffario. Il costo è ripartito tra i clienti in base al carico.
   */
  function ricalcolaViaggi(viaggi, sedi, distanze, pvMap, P, tariffe) {
    var mappa = {};
    distanze.forEach(function (d) { mappa[d.sede + '#' + d.pv] = d; });
    var attive = CODICI_SEDI.filter(function (c) { return sedi[c] && sedi[c].lat !== null && sedi[c].lat !== undefined; });
    var per = periodoViaggi(viaggi);
    var fatt = P.km_fatturati === 'AR' ? 2 : 1;
    var tot = {}, perPV = {}, dettaglio = [];
    attive.forEach(function (c) { tot[c] = { viaggi: 0, km: 0, costo: 0, costoAnno: 0, mancanti: 0 }; perPV[c] = {}; });
    viaggi.forEach(function (v) {
      var riga = { viaggio: v, sedi: {} };
      var occTot = v.clienti.reduce(function (s, c) { return s + (c.occ > 0 ? c.occ : 0); }, 0);
      attive.forEach(function (sc) {
        var max = 0, manca = false;
        v.clienti.forEach(function (c) {
          var pv = pvMap[c.pv], d = mappa[sc + '#' + c.pv];
          if (!pv || !d || d.chiave !== chiaveCoord(sedi[sc], pv)) { manca = true; return; }
          if (d.km > max) max = d.km;
        });
        if (manca) { tot[sc].mancanti++; riga.sedi[sc] = null; return; }
        var km = max * fatt, costo = costoViaggio(km, v.mezzo, tariffe, P);
        tot[sc].viaggi++; tot[sc].km += km; tot[sc].costo += costo;
        riga.sedi[sc] = { km: km, costo: costo };
        v.clienti.forEach(function (c) {
          var quota = occTot > 0 ? Math.max(c.occ, 0) / occTot : 1 / v.clienti.length;
          var x = perPV[sc][c.pv] = perPV[sc][c.pv] || { viaggi: 0, costo: 0, occ: 0 };
          x.viaggi++; x.costo += costo * quota; x.occ += Math.max(c.occ, 0);
        });
      });
      dettaglio.push(riga);
    });
    attive.forEach(function (c) {
      tot[c].costoAnno = per ? tot[c].costo * per.fattoreAnno : 0;
      Object.keys(perPV[c]).forEach(function (k) { perPV[c][k].costoAnno = per ? perPV[c][k].costo * per.fattoreAnno : 0; });
    });
    return { attive: attive, tot: tot, perPV: perPV, dettaglio: dettaglio, periodo: per };
  }

  function riepilogoViaggi(sedi, R) {
    var rif = R.tot.ATTUALE, ott = R.tot.OTTIMO;
    return R.attive.map(function (c) {
      var x = R.tot[c];
      return {
        codice: c, nome: sedi[c].nome, indirizzo: sedi[c].indirizzo, viaggi: x.viaggi, km: x.km, costo: x.costo, costoAnno: x.costoAnno, mancanti: x.mancanti,
        deltaAnno: rif && c !== 'ATTUALE' ? x.costoAnno - rif.costoAnno : null,
        deltaPct: rif && c !== 'ATTUALE' && rif.costoAnno ? (x.costoAnno - rif.costoAnno) / rif.costoAnno * 100 : null,
        deltaKm: rif && c !== 'ATTUALE' ? x.km - rif.km : null,
        sopraOttimo: ott && c !== 'OTTIMO' ? x.costoAnno - ott.costoAnno : null
      };
    });
  }

  /**
   * Punto di ottimo per i viaggi reali: minimizza Σ costo(km al cliente più lontano di ogni viaggio).
   * Distanze in linea d'aria × fattore di tortuosità (stimato dalle distanze stradali già calcolate). Ricerca a griglia con raffinamento.
   */
  function ottimoViaggi(viaggi, coordPV, P, tariffe, tortuosita) {
    var k = tortuosita > 0 ? tortuosita : 1.3, fatt = P.km_fatturati === 'AR' ? 2 : 1;
    var gruppi = viaggi.map(function (v) {
      return { mezzo: v.mezzo, punti: v.clienti.map(function (c) { return coordPV[c.pv]; }).filter(Boolean) };
    }).filter(function (g) { return g.punti.length; });
    if (!gruppi.length) throw new Error('Servono viaggi con clienti geolocalizzati.');
    var tutti = []; gruppi.forEach(function (g) { tutti = tutti.concat(g.punti); });
    var lat0 = tutti.reduce(function (s, p) { return s + p.lat; }, 0) / tutti.length;
    var kx = 111.320 * Math.cos(lat0 * Math.PI / 180), ky = 110.574;
    function f(lat, lng) {
      var s = 0;
      for (var i = 0; i < gruppi.length; i++) {
        var g = gruppi[i], m = 0;
        for (var j = 0; j < g.punti.length; j++) {
          var dx = (g.punti[j].lng - lng) * kx, dy = (g.punti[j].lat - lat) * ky, d = Math.sqrt(dx * dx + dy * dy);
          if (d > m) m = d;
        }
        s += costoViaggio(m * k * fatt, g.mezzo, tariffe, P);
      }
      return s;
    }
    var la = tutti.map(function (p) { return p.lat; }), lo = tutti.map(function (p) { return p.lng; });
    var b = { la1: Math.min.apply(null, la), la2: Math.max.apply(null, la), lo1: Math.min.apply(null, lo), lo2: Math.max.apply(null, lo) };
    var best = { v: Infinity }, N = 40;
    for (var giro = 0; giro < 5; giro++) {
      var dla = (b.la2 - b.la1) / N, dlo = (b.lo2 - b.lo1) / N;
      for (var i = 0; i <= N; i++) for (var j = 0; j <= N; j++) {
        var lat = b.la1 + i * dla, lng = b.lo1 + j * dlo, v = f(lat, lng);
        if (v < best.v) best = { v: v, lat: lat, lng: lng };
      }
      b = { la1: best.lat - 2 * dla, la2: best.lat + 2 * dla, lo1: best.lng - 2 * dlo, lo2: best.lng + 2 * dlo };
    }
    return { lat: best.lat, lng: best.lng, costoStimato: best.v };
  }

  /** Primo foglio non vuoto di un file Excel letto con SheetJS -> array di righe (date come numero seriale). */
  function righeDaExcel(XLSX, buffer) {
    var wb = XLSX.read(buffer, { type: 'array', dense: true, cellDates: false, cellFormula: false, cellHTML: false, cellText: false });
    for (var i = 0; i < wb.SheetNames.length; i++) {
      var righe = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]], { header: 1, raw: true, defval: '', blankrows: true });
      if (righe.some(function (r) { return r && r.some(function (c) { return String(c).trim() !== ''; }); })) return righe;
    }
    throw new Error('Il file Excel non contiene dati.');
  }

  function tortuosita(sede, distanze, pvMap) {
    var r = distanze.filter(function (d) { return d.sede === sede.codice && pvMap[d.pv]; }).map(function (d) {
      var l = distanzaKm(sede, pvMap[d.pv]); return l > 5 ? d.km / l : null;
    }).filter(function (x) { return x && x > 1 && x < 3; }).sort(function (a, b) { return a - b; });
    return r.length ? r[Math.floor(r.length / 2)] : 1.3;
  }

  /** Estrazione per i viaggi reali: riepilogo per sede, dettaglio per PV (costo ripartito) e dettaglio per viaggio. */
  function estrazioneViaggi(sedi, R, pvMap) {
    var mancanti = R.attive.reduce(function (s, c) { return s + R.tot[c].mancanti; }, 0);
    if (mancanti) throw new Error('Ci sono ' + mancanti + ' viaggi non calcolabili per distanze mancanti: premere "Aggiorna distanze" prima di estrarre.');
    var nomeS = function (c) { return sedi[c].nome; };
    var intestRiep = ['Sede', 'Indirizzo', 'Viaggi', 'Km fatturati nel periodo', 'Costo nel periodo €', 'Costo/anno €', 'Δ costo/anno € vs attuale', 'Δ %', 'Sopra l\'ottimo €/anno'];
    var righeRiep = riepilogoViaggi(sedi, R).map(function (s) {
      return [s.nome, s.indirizzo, s.viaggi, arr(s.km, 0), arr(s.costo, 0), arr(s.costoAnno, 0), s.deltaAnno === null ? '' : arr(s.deltaAnno, 0),
        s.deltaPct === null ? '' : arr(s.deltaPct, 1), s.sopraOttimo === null ? '' : arr(s.sopraOttimo, 0)];
    });
    var intest = ['Codice PV', 'Nome PV', 'Sede', 'Viaggi nel periodo', 'Costo ripartito nel periodo €', 'Costo ripartito/anno €', 'Δ costo/anno € vs attuale', 'Δ %'];
    var righe = [];
    var codici = {}; R.attive.forEach(function (c) { Object.keys(R.perPV[c]).forEach(function (k) { codici[k] = true; }); });
    Object.keys(codici).sort(function (a, b) { return a.localeCompare(b, 'it', { numeric: true }); }).forEach(function (k) {
      var a = R.perPV.ATTUALE && R.perPV.ATTUALE[k];
      R.attive.forEach(function (c) {
        var x = R.perPV[c][k]; if (!x) return;
        var d = c !== 'ATTUALE' && a ? x.costoAnno - a.costoAnno : null;
        righe.push([k, pvMap[k] ? pvMap[k].nome : '', nomeS(c), x.viaggi, arr(x.costo, 0), arr(x.costoAnno, 0), d === null ? '' : arr(d, 0), d === null || !a.costoAnno ? '' : arr(d / a.costoAnno * 100, 1)]);
      });
    });
    var intestV = ['Viaggio', 'Data', 'Giro', 'Vettore', 'Mezzo', 'Clienti', 'Carico (unità)'];
    R.attive.forEach(function (c) { intestV.push('Km ' + nomeS(c), 'Costo € ' + nomeS(c)); });
    var righeV = R.dettaglio.map(function (d) {
      var v = d.viaggio, r = [v.id, v.data, v.giro, v.vettore, v.mezzo, v.clienti.map(function (c) { return c.pv; }).join(' '),
        arr(v.clienti.reduce(function (s, c) { return s + c.occ; }, 0), 2)];
      R.attive.forEach(function (c) { var x = d.sedi[c]; r.push(x ? arr(x.km, 1) : '', x ? arr(x.costo, 2) : ''); });
      return r;
    });
    return { intestazioneRiepilogo: intestRiep, riepilogo: righeRiep, intestazione: intest, righe: righe, intestazioneViaggi: intestV, viaggi: righeV };
  }

  /* ============================ Adeguamento gasolio (Allegato E) e CO2 ============================ */
  var GASOLIO_DEF = { rif: 1.289, quota: 0.30, franchigia: 0.05, consumoMotrice: 0.28, consumoBilico: 0.33, co2: 2.65 };

  /** Parametri del gasolio dai parametri generali (quote e franchigia in frazione: 0,30 = 30%). */
  function parametriGasolio(P) {
    var v = function (x, d) { return x != null && isFinite(x) ? Number(x) : d; };
    return { rif: v(P.gas_rif, GASOLIO_DEF.rif), quota: v(P.gas_quota, GASOLIO_DEF.quota), franchigia: v(P.gas_franchigia, GASOLIO_DEF.franchigia),
      consumoMotrice: v(P.consumo_motrice, GASOLIO_DEF.consumoMotrice), consumoBilico: v(P.consumo_bilico, GASOLIO_DEF.consumoBilico),
      co2: v(P.co2_kg_l, GASOLIO_DEF.co2), fatt: P.km_fatturati === 'AR' ? 2 : 1 };
  }

  /** 'AAAA-MM' del mese della data, spostato di `scarto` mesi (-1 = mese precedente). */
  function meseDi(dataISO, scarto) {
    var a = Number(String(dataISO).slice(0, 4)), m = Number(String(dataISO).slice(5, 7)) - 1 + (scarto || 0);
    a += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return a + '-' + String(m + 1).padStart(2, '0');
  }

  /**
   * Adeguamento del mese: variazione del prezzo medio rispetto al riferimento; se in valore assoluto supera la franchigia
   * si applica TUTTA la variazione alla quota di tariffa legata al gasolio (positivo = a favore del vettore).
   */
  function adeguamentoGasolio(prezzo, G) {
    if (!(prezzo > 0)) return null;
    var v = (prezzo - G.rif) / G.rif, applicato = Math.abs(v) > G.franchigia;
    return { variazione: v, applicato: applicato, adeguamento: applicato ? G.quota * v : 0 };
  }

  function classeMezzo(m) { return /BIL|BIGA|SEMIRIM|ARTIC|TRATT|AUTOTRENO/i.test(String(m || '')) ? 'bilico' : 'motrice'; }

  /**
   * Gasolio e CO2 per sede sui viaggi ricalcolati (R da ricalcolaViaggi).
   * Adeguamento € = Σ costo del viaggio × adeguamento del mese (prezzo del mese precedente a quello del viaggio).
   * Litri = km percorsi (andata e ritorno fino al cliente più lontano) × consumo del mezzo; CO2 = litri × kg/l.
   */
  function gasolioViaggi(R, prezzi, G) {
    var mesi = {}, tot = {};
    R.attive.forEach(function (c) { tot[c] = { viaggi: 0, costoBase: 0, adeguamento: 0, kmPercorsi: 0, litri: 0 }; });
    R.dettaglio.forEach(function (d) {
      var mv = meseDi(d.viaggio.data, 0);
      if (!mesi[mv]) {
        var mp = meseDi(d.viaggio.data, -1), p = prezzi[mp], a = adeguamentoGasolio(p, G);
        mesi[mv] = { mese: mv, mesePrezzo: mp, prezzo: a ? Number(p) : null, variazione: a ? a.variazione : null, applicato: a ? a.applicato : false,
          adeguamento: a ? a.adeguamento : 0, mancante: !a, viaggi: 0 };
      }
      var M = mesi[mv];
      M.viaggi++;
      var cons = classeMezzo(d.viaggio.mezzo) === 'bilico' ? G.consumoBilico : G.consumoMotrice;
      R.attive.forEach(function (c) {
        var x = d.sedi[c]; if (!x) return;
        var t = tot[c], km = x.km * (G.fatt === 2 ? 1 : 2);
        t.viaggi++; t.costoBase += x.costo; t.adeguamento += x.costo * M.adeguamento; t.kmPercorsi += km; t.litri += km * cons;
      });
    });
    var f = R.periodo ? R.periodo.fattoreAnno : 0, rif = tot.ATTUALE;
    var annuo = function (t) {
      return { litri: t.litri * f, co2: t.litri * G.co2 / 1000 * f, adeguamento: t.adeguamento * f, costoBase: t.costoBase * f, costoTotale: (t.costoBase + t.adeguamento) * f };
    };
    var aRif = rif ? annuo(rif) : null;
    var sedi = R.attive.map(function (c) {
      var t = tot[c], a = annuo(t), conf = aRif && c !== 'ATTUALE';
      return { codice: c, viaggi: t.viaggi, kmPercorsi: t.kmPercorsi, litri: t.litri, co2: t.litri * G.co2 / 1000, adeguamento: t.adeguamento, costoBase: t.costoBase,
        anno: a,
        delta: conf ? { litri: a.litri - aRif.litri, co2: a.co2 - aRif.co2, co2Pct: aRif.co2 ? (a.co2 - aRif.co2) / aRif.co2 * 100 : null,
          adeguamento: a.adeguamento - aRif.adeguamento, costoTotale: a.costoTotale - aRif.costoTotale } : null };
    });
    var lista = Object.keys(mesi).sort().map(function (k) { return mesi[k]; });
    return { sedi: sedi, mesi: lista, mesiMancanti: lista.filter(function (m) { return m.mancante; }).map(function (m) { return m.mesePrezzo; }), parametri: G };
  }

  /** Fogli di estrazione per gasolio e CO2. */
  function estrazioneGasolio(sedi, g) {
    var intest = ['Sede', 'Km percorsi nel periodo', 'Litri nel periodo', 'CO₂ t nel periodo', 'Adeguamento gasolio € nel periodo',
      'Litri/anno', 'CO₂ t/anno', 'Δ CO₂ t/anno vs attuale', 'Δ CO₂ %', 'Adeguamento €/anno', 'Δ adeguamento €/anno', 'Costo con adeguamento €/anno', 'Δ costo con adeguamento €/anno'];
    var righe = g.sedi.map(function (s) {
      var d = s.delta;
      return [sedi[s.codice].nome, arr(s.kmPercorsi, 0), arr(s.litri, 0), arr(s.co2, 1), arr(s.adeguamento, 0), arr(s.anno.litri, 0), arr(s.anno.co2, 1),
        d ? arr(d.co2, 1) : '', d && d.co2Pct != null ? arr(d.co2Pct, 1) : '', arr(s.anno.adeguamento, 0), d ? arr(d.adeguamento, 0) : '', arr(s.anno.costoTotale, 0), d ? arr(d.costoTotale, 0) : ''];
    });
    var intestM = ['Mese dei viaggi', 'Mese del prezzo', 'Prezzo €/l', 'Variazione %', 'Oltre la franchigia', 'Adeguamento % sulla tariffa', 'Viaggi'];
    var righeM = g.mesi.map(function (m) {
      return [m.mese, m.mesePrezzo, m.prezzo == null ? 'mancante' : m.prezzo, m.variazione == null ? '' : arr(m.variazione * 100, 2), m.mancante ? '' : (m.applicato ? 'sì' : 'no'),
        arr(m.adeguamento * 100, 2), m.viaggi];
    });
    return { intestazione: intest, righe: righe, intestazioneMesi: intestM, mesi: righeM };
  }

  /** Tariffario da tabella: colonne anno, mezzo (facoltativa), km da, km a, €/km, € fisso. */
  function preparaTariffe(righe) {
    var iHdr = righe.findIndex(function (r) { return r && r.some(function (c) { return String(c == null ? '' : c).trim() !== ''; }); });
    if (iHdr < 0) throw new Error('Il file è vuoto.');
    var norm = righe[iHdr].map(normTitolo);
    var trova = function (al) { for (var a = 0; a < al.length; a++) { var i = norm.indexOf(al[a]); if (i >= 0) return i; } return -1; };
    var c = { anno: trova(['anno', 'anno validita']), mezzo: trova(['mezzo', 'tipo mezzo', 'tipomezzo']), da: trova(['km da', 'da km', 'km min', 'da']),
      a: trova(['km a', 'a km', 'km max', 'a']), ekm: trova(['euro km', 'eur km', '€ km', '€/km', 'euro/km', 'tariffa km', 'costo km']),
      fisso: trova(['euro fisso', '€ fisso', 'fisso', 'euro viaggio', '€ viaggio', 'costo viaggio', 'importo']) };
    if (c.da < 0 || (c.ekm < 0 && c.fisso < 0)) throw new Error('Colonne del tariffario non riconosciute: servono almeno "km da" e "€/km" o "€ fisso". Intestazioni: ' + righe[iHdr].join(' | '));
    var out = [];
    righe.slice(iHdr + 1).forEach(function (r) {
      if (!r || r.every(function (x) { return String(x == null ? '' : x).trim() === ''; })) return;
      var v = function (i) { return i < 0 ? '' : String(r[i] == null ? '' : r[i]).trim(); };
      out.push({ anno: v(c.anno) ? Math.round(num(v(c.anno), 'anno')) : null, mezzo: v(c.mezzo) || '*', km_da: num(v(c.da) || '0', 'km da'),
        km_a: v(c.a) ? num(v(c.a), 'km a') : null, euro_km: v(c.ekm) ? num(v(c.ekm), '€/km') : 0, euro_fisso: v(c.fisso) ? num(v(c.fisso), '€ fisso') : 0 });
    });
    if (!out.length) throw new Error('Nessuna riga di tariffa trovata.');
    return out;
  }

  /** Righe grezze (array di array) -> {tipo, validi, scartati, ...}. Riconosce l'anagrafica con volumi e i carichi giornalieri. */
  function preparaImport(righe) {
    var iV = righe.findIndex(function (r) { var c = r ? colonneViaggi(r) : {}; return c.viaggio !== undefined && c.codice !== undefined && c.data !== undefined; });
    if (iV >= 0) return preparaViaggi(righe, iV);
    var iHdr = righe.findIndex(function (r) { return r && r.some(function (c) { return String(c == null ? '' : c).trim() !== ''; }) && mappaColonne(r).codice !== undefined; });
    if (iHdr < 0) iHdr = righe.findIndex(function (r) { return r && r.some(function (c) { return String(c == null ? '' : c).trim() !== ''; }); });
    if (iHdr < 0) throw new Error('Il file è vuoto.');
    var col = mappaColonne(righe[iHdr]);
    var colonneData = [];
    righe[iHdr].forEach(function (h, i) { var d = leggiData(h); if (d) colonneData.push({ indice: i, data: d }); });
    if (col.codice !== undefined && (colonneData.length || (col.data !== undefined && col.colli !== undefined))) {
      if (col.indirizzo === undefined && col.comune === undefined) throw new Error('Colonne non riconosciute: indirizzo. Intestazioni trovate: ' + righe[iHdr].join(' | '));
      return togliFuoriPerimetro(preparaGiornaliero(righe, iHdr, col, colonneData));
    }
    var mancano = ['codice', 'pallet', 'consegne'].filter(function (c) { return col[c] === undefined; });
    if (col.indirizzo === undefined && col.comune === undefined && col.lat === undefined && col.coordinate === undefined) mancano.push('indirizzo');
    if (mancano.length) throw new Error('Colonne non riconosciute: ' + mancano.join(', ') + '. Intestazioni trovate: ' + righe[iHdr].join(' | '));
    var validi = [], scartati = [], visti = {};
    righe.slice(iHdr + 1).forEach(function (r, k) {
      var riga = iHdr + k + 2;
      var v = function (c) { return col[c] === undefined ? '' : String(r[col[c]] === undefined || r[col[c]] === null ? '' : r[col[c]]).trim(); };
      if (!r || r.every(function (c) { return String(c === null || c === undefined ? '' : c).trim() === ''; })) return;
      try {
        var codice = v('codice');
        if (/^\d+\.0+$/.test(codice)) codice = codice.replace(/\.0+$/, '');
        if (!codice) throw new Error('codice mancante');
        if (visti[codice]) throw new Error('codice duplicato (anche alla riga ' + visti[codice] + ')');
        var indirizzo = componiIndirizzo(v);
        var pos = null;
        if (v('coordinate')) pos = leggiCoordinate(v('coordinate'));
        else if (v('lat') && v('lng')) pos = leggiCoordinate(v('lat') + ', ' + v('lng'));
        if (!indirizzo && !pos) throw new Error('indirizzo mancante');
        var pallet = num(v('pallet'), 'pallet'), consegne = num(v('consegne'), 'consegne');
        if (!(pallet > 0)) throw new Error('pallet/settimana deve essere > 0');
        if (!(consegne > 0)) throw new Error('consegne/settimana deve essere > 0');
        if (consegne > 14) throw new Error('consegne/settimana non plausibili (' + consegne + ')');
        visti[codice] = riga;
        validi.push({ riga: riga, codice: codice, nome: v('nome'), indirizzo: indirizzo, pos: pos, pallet: pallet, consegne: consegne });
      } catch (e) {
        scartati.push({ riga: riga, codice: v('codice'), motivo: e.message });
      }
    });
    return togliFuoriPerimetro({ tipo: 'anagrafica', validi: validi, scartati: scartati, avvisi: [], colonne: col });
  }

  /** CSV -> array di righe. Separatore rilevato (; , tab), virgolette gestite, BOM rimosso. */
  function leggiCSV(testo) {
    testo = String(testo || '').replace(/^﻿/, '');
    var prima = testo.split(/\r?\n/)[0] || '';
    var sep = [';', '\t', ','].map(function (s) { return [s, prima.split(s).length]; }).sort(function (a, b) { return b[1] - a[1]; })[0][0];
    var righe = [], riga = [], campo = '', inVirg = false;
    for (var i = 0; i < testo.length; i++) {
      var c = testo[i];
      if (inVirg) {
        if (c === '"') { if (testo[i + 1] === '"') { campo += '"'; i++; } else inVirg = false; }
        else campo += c;
      } else if (c === '"') inVirg = true;
      else if (c === sep) { riga.push(campo); campo = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && testo[i + 1] === '\n') i++;
        riga.push(campo); righe.push(riga); riga = []; campo = '';
      } else campo += c;
    }
    if (campo !== '' || riga.length) { riga.push(campo); righe.push(riga); }
    return righe;
  }

  function aBlocchi(lista, n) {
    var out = [];
    for (var i = 0; i < lista.length; i += n) out.push(lista.slice(i, i + n));
    return out;
  }

  return {
    CODICI_SEDI: CODICI_SEDI, num: num, validaParametri: validaParametri, leggiCoordinate: leggiCoordinate,
    chiaveCoord: chiaveCoord, metriche: metriche, delta: delta, weiszfeld: weiszfeld, pesiOttimo: pesiOttimo,
    tabella: tabella, riepilogo: riepilogo, estrazione: estrazione, csv: csv, mappaColonne: mappaColonne,
    preparaImport: preparaImport, leggiCSV: leggiCSV, aBlocchi: aBlocchi, arr: arr,
    volumePV: volumePV, volumi: volumi, costoViaggio: costoViaggio, normTesto: normTesto, comuneDaEtichetta: comuneDaEtichetta, ricalcolaViaggi: ricalcolaViaggi, riepilogoViaggi: riepilogoViaggi,
    ottimoViaggi: ottimoViaggi, preparaTariffe: preparaTariffe, righeDaExcel: righeDaExcel, tortuosita: tortuosita, estrazioneViaggi: estrazioneViaggi, periodoViaggi: periodoViaggi, REPARTI_CODICE: REPARTI_CODICE, distanzaKm: distanzaKm, comuneDaIndirizzo: comuneDaIndirizzo, provinciaDaIndirizzo: provinciaDaIndirizzo, provinciaDaEtichetta: provinciaDaEtichetta, leggiData: leggiData, pulisciIndirizzo: pulisciIndirizzo, normReparto: normReparto,
    GASOLIO_DEF: GASOLIO_DEF, parametriGasolio: parametriGasolio, meseDi: meseDi, adeguamentoGasolio: adeguamentoGasolio, classeMezzo: classeMezzo,
    gasolioViaggi: gasolioViaggi, estrazioneGasolio: estrazioneGasolio,
    PROVINCE_FUORI_PERIMETRO: PROVINCE_FUORI_PERIMETRO, fuoriPerimetro: fuoriPerimetro, pvFuoriPerimetro: pvFuoriPerimetro
  };
});
