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

  function metriche(pv, sede, dist, P) {
    var cap = sede && sede.capacita > 0 ? sede.capacita : P.capacita_pallet;
    var palletConsegna = pv.pallet / pv.consegne;
    var viaggiConsegna = Math.ceil(palletConsegna / cap - 1e-9);
    var viaggiSett = pv.consegne * viaggiConsegna;
    var kmFattViaggio = dist.km * (P.km_fatturati === 'AR' ? 2 : 1);
    var costoViaggio = kmFattViaggio * P.euro_km + P.costo_fisso_viaggio;
    var costoSett = viaggiSett * costoViaggio;
    return {
      km: dist.km, minuti: dist.minuti, viaggiSett: viaggiSett, kmSett: viaggiSett * kmFattViaggio,
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
      return { lat: p.lat, lng: p.lng, w: m.viaggiSett * kmFatt * P.euro_km };
    });
  }

  /** Tabella completa: metriche per PV e sede, totali, distanze mancanti. */
  function tabella(P, sedi, pvLista, distanze) {
    var mappa = {};
    distanze.forEach(function (d) { mappa[d.sede + '#' + d.pv] = d; });
    var attive = CODICI_SEDI.filter(function (c) { return sedi[c] && sedi[c].lat !== null && sedi[c].lat !== undefined; });
    var tot = {};
    attive.forEach(function (c) { tot[c] = { viaggiSett: 0, kmSett: 0, costoSett: 0, costoAnno: 0, mancanti: 0 }; });
    var righe = pvLista.map(function (pv) {
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
    return { attive: attive, righe: righe, tot: tot };
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
    codice: ['codice', 'cod', 'codice pv', 'codicepv', 'cod pv', 'id', 'pv', 'punto vendita', 'codice punto vendita', 'negozio', 'store'],
    nome: ['nome', 'descrizione', 'insegna', 'ragione sociale', 'denominazione', 'nome pv'],
    indirizzo: ['indirizzo', 'indirizzo completo', 'via', 'address'],
    cap: ['cap', 'c.a.p.', 'codice postale'],
    comune: ['comune', 'citta', 'città', 'localita', 'località', 'city'],
    provincia: ['provincia', 'prov', 'pr', 'sigla provincia'],
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

  /** Righe grezze (array di array, prima riga = intestazione) -> {validi, scartati, colonne}. */
  function preparaImport(righe) {
    var iHdr = righe.findIndex(function (r) { return r && r.some(function (c) { return String(c).trim() !== ''; }); });
    if (iHdr < 0) throw new Error('Il file è vuoto.');
    var col = mappaColonne(righe[iHdr]);
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
        var indirizzo = v('indirizzo').replace(/\s+/g, ' ');
        var extra = [v('cap'), v('comune'), v('provincia') ? '(' + v('provincia').toUpperCase() + ')' : ''].filter(Boolean).join(' ');
        // aggiunge CAP/comune/provincia salvo che l'indirizzo li contenga già (", Comune" o il CAP)
        var com = v('comune'), cap = v('cap');
        var giaPresente = (cap && indirizzo.indexOf(cap) >= 0) ||
          (com && new RegExp(',\\s*(\\d{5}\\s+)?' + com.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(indirizzo));
        if (extra && !giaPresente) indirizzo = indirizzo ? indirizzo + ', ' + extra : extra;
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
    return { validi: validi, scartati: scartati, colonne: col };
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
    preparaImport: preparaImport, leggiCSV: leggiCSV, aBlocchi: aBlocchi, arr: arr
  };
});
