/* Simulatore CEDI — scheda Dashboard: KPI per sede, confronti, andamento mensile, gasolio, mappa schematica.
   Solo disegno (SVG generato da dati già calcolati): nessun accesso al database. */
(function (root) {
  'use strict';

  var COLORI = { ATTUALE: '#667085', OPZ1: '#1f5fbf', OPZ2: '#b54708', OPZ3: '#7a5af8', OTTIMO: '#067647' };
  var VERDE = '#067647', ROSSO = '#b42318', GRIGIO = '#98a2b3', GRIGLIA = '#e4e7ec', TESTO = '#1d2330', MUTO = '#667085';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(x, d) { return x == null || isNaN(x) ? '—' : Number(x).toLocaleString('it-IT', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function segno(x, d, suff) { return x == null || isNaN(x) ? '—' : (x > 0 ? '+' : x < 0 ? '−' : '') + fmt(Math.abs(x), d) + (suff || ''); }
  function colore(c) { return COLORI[c] || '#475467'; }
  function nomeMese(k) { var n = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic']; return n[Number(k.slice(5, 7)) - 1] + ' ' + k.slice(2, 4); }
  function testo(x, y, t, o) {
    o = o || {};
    return '<text x="' + x + '" y="' + y + '" font-size="' + (o.size || 12) + '" fill="' + (o.fill || TESTO) + '"' + (o.anchor ? ' text-anchor="' + o.anchor + '"' : '') +
      (o.weight ? ' font-weight="' + o.weight + '"' : '') + '>' + esc(t) + '</text>';
  }
  function svg(w, h, corpo, titolo) { return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" role="img" aria-label="' + esc(titolo) + '" style="max-width:' + w + 'px;display:block">' + corpo + '</svg>'; }

  /** Barre orizzontali divergenti attorno allo zero (Interporto = 0). */
  function barreDelta(righe, valore, etichetta, titolo) {
    var w = 720, sx = 190, larg = 470, h = 34 + righe.length * 40;
    var vals = righe.map(valore), lo = Math.min(0, Math.min.apply(null, vals)), hi = Math.max(0, Math.max.apply(null, vals));
    if (hi === lo) hi = lo + 1;
    var x = function (v) { return sx + (v - lo) / (hi - lo) * larg; }, x0 = x(0);
    var c = '';
    righe.forEach(function (r, i) {
      var v = valore(r), y = 14 + i * 40, xa = Math.min(x(v), x0), wd = Math.max(1, Math.abs(x(v) - x0));
      c += testo(0, y + 18, r.nome, { size: 13 });
      c += '<rect x="' + xa + '" y="' + y + '" width="' + wd + '" height="26" rx="3" fill="' + (r.codice === 'OTTIMO' ? GRIGIO : v < 0 ? VERDE : ROSSO) + '" fill-opacity="0.75"><title>' + esc(r.nome + ': ' + etichetta(r)) + '</title></rect>';
      var dentro = wd > 150;
      c += testo(v < 0 ? (dentro ? xa + 8 : x0 + 8) : (dentro ? x(v) - 8 : x(v) + 6), y + 18, etichetta(r), { size: 12, anchor: v < 0 ? 'start' : (dentro ? 'end' : 'start'), fill: dentro ? '#fff' : TESTO, weight: 600 });
    });
    c += '<line x1="' + x0 + '" x2="' + x0 + '" y1="6" y2="' + (h - 18) + '" stroke="' + MUTO + '" stroke-width="1.5"/>';
    c += testo(x0, h - 4, 'Interporto = 0', { size: 11, fill: MUTO, anchor: 'middle' });
    return svg(w, h, c, titolo);
  }

  /** Linee del Δ% mensile di ogni sede candidata rispetto all'Interporto. */
  function lineeMensili(mesi, sedi, titolo) {
    var cand = sedi.filter(function (s) { return s.codice !== 'ATTUALE'; });
    var punti = cand.map(function (s) {
      return mesi.map(function (m) {
        var a = m.sedi.ATTUALE, x = m.sedi[s.codice];
        return a && x && a.costoTot ? (x.costoTot - a.costoTot) / a.costoTot * 100 : null;
      });
    });
    var tutti = [].concat.apply([0], punti).filter(function (v) { return v != null; });
    var lo = Math.floor(Math.min.apply(null, tutti) - 1), hi = Math.ceil(Math.max.apply(null, tutti) + 1);
    var w = 720, sx = 56, ex = 600, y0 = 18, y1 = 230, h = 262;
    var X = function (i) { return mesi.length < 2 ? (sx + ex) / 2 : sx + i * (ex - sx) / (mesi.length - 1); };
    var Y = function (v) { return y1 - (v - lo) / (hi - lo) * (y1 - y0); };
    var c = '', passo = Math.max(1, Math.ceil((hi - lo) / 6));
    for (var t = Math.ceil(lo / passo) * passo; t <= hi; t += passo) {
      c += '<line x1="' + sx + '" x2="' + ex + '" y1="' + Y(t) + '" y2="' + Y(t) + '" stroke="' + (t === 0 ? MUTO : GRIGLIA) + '"' + (t === 0 ? ' stroke-width="1.5"' : '') + '/>';
      c += testo(sx - 8, Y(t) + 4, segno(t, 0, '%'), { size: 11, fill: MUTO, anchor: 'end' });
    }
    mesi.forEach(function (m, i) { c += testo(X(i), h - 8, nomeMese(m.mese), { size: 11, fill: MUTO, anchor: 'middle' }); });
    cand.forEach(function (s, k) {
      var pts = punti[k].map(function (v, i) { return v == null ? null : [X(i), Y(v), v]; }).filter(Boolean);
      if (!pts.length) return;
      c += '<polyline fill="none" stroke="' + colore(s.codice) + '" stroke-width="2.5"' + (s.codice === 'OTTIMO' ? ' stroke-dasharray="5 4"' : '') + ' points="' + pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' ') + '"/>';
      pts.forEach(function (p, i) { c += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="4" fill="' + colore(s.codice) + '"><title>' + esc(s.nome + ', ' + nomeMese(mesi[i].mese) + ': ' + segno(p[2], 1, '%')) + '</title></circle>'; });
      var u = pts[pts.length - 1];
      c += testo(u[0] + 10, u[1] + 4, s.nome + ' ' + segno(u[2], 1, '%'), { size: 12, fill: colore(s.codice), weight: 600 });
    });
    return svg(w + 60, h, c, titolo);
  }

  /** Adeguamento gasolio mese per mese: barre in % con l'importo per l'Interporto. */
  function barreGasolio(mesi, franchigia, titolo) {
    var w = 720, sx = 56, ex = 700, y0 = 20, y1 = 190, h = 236;
    var vals = mesi.map(function (m) { return m.adeguamento * 100; });
    var hi = Math.max(1, Math.ceil(Math.max.apply(null, vals.concat([0])) + 1)), lo = Math.min(0, Math.floor(Math.min.apply(null, vals.concat([0])) - 1));
    var Y = function (v) { return y1 - (v - lo) / (hi - lo) * (y1 - y0); };
    var bw = Math.min(70, (ex - sx) / Math.max(1, mesi.length) * 0.6), c = '';
    [lo, 0, hi].forEach(function (t) { c += '<line x1="' + sx + '" x2="' + ex + '" y1="' + Y(t) + '" y2="' + Y(t) + '" stroke="' + (t === 0 ? MUTO : GRIGLIA) + '"/>' + testo(sx - 8, Y(t) + 4, fmt(t, 0) + '%', { size: 11, fill: MUTO, anchor: 'end' }); });
    mesi.forEach(function (m, i) {
      var cx = sx + (i + 0.5) * (ex - sx) / mesi.length, v = m.adeguamento * 100, ya = Math.min(Y(v), Y(0)), hh = Math.max(1, Math.abs(Y(v) - Y(0)));
      var euro = m.sedi.ATTUALE ? m.sedi.ATTUALE.adeguamento : null;
      c += '<rect x="' + (cx - bw / 2) + '" y="' + ya + '" width="' + bw + '" height="' + hh + '" rx="3" fill="' + (m.mancante ? GRIGLIA : '#b54708') + '" fill-opacity="0.8"><title>' +
        esc(nomeMese(m.mese) + ': ' + (m.mancante ? 'prezzo mancante' : fmt(m.prezzo, 3) + ' €/l, variazione ' + segno(m.variazione * 100, 1, '%') + ', adeguamento ' + segno(v, 2, '%'))) + '</title></rect>';
      c += testo(cx, ya - 6, m.mancante ? 'n.d.' : segno(v, 2, '%'), { size: 12, anchor: 'middle', weight: 600 });
      c += testo(cx, h - 26, nomeMese(m.mese), { size: 11, fill: MUTO, anchor: 'middle' });
      if (euro != null && !m.mancante) c += testo(cx, h - 10, fmt(euro, 0) + ' €', { size: 11, fill: MUTO, anchor: 'middle' });
    });
    return svg(w, h, c, titolo) + '<p class="muted">Barre: adeguamento sulla tariffa (franchigia ' + fmt(franchigia * 100, 0) + '% sottratta). Sotto: importo per i viaggi dall\'Interporto nel mese.</p>';
  }

  /** Mappa schematica: clienti (cerchi ∝ viaggi) e sedi, in proiezione locale. */
  function mappa(punti, sedi, titolo) {
    var tutti = punti.concat(sedi);
    if (!tutti.length) return '';
    var lat0 = tutti.reduce(function (s, p) { return s + p.lat; }, 0) / tutti.length, kx = Math.cos(lat0 * Math.PI / 180);
    var xs = tutti.map(function (p) { return p.lng * kx; }), ys = tutti.map(function (p) { return p.lat; });
    var x1 = Math.min.apply(null, xs), x2 = Math.max.apply(null, xs), y1 = Math.min.apply(null, ys), y2 = Math.max.apply(null, ys);
    var w = 720, pad = 24, sc = Math.min((w - 2 * pad) / (x2 - x1 || 1), 560 / (y2 - y1 || 1)), h = (y2 - y1) * sc + 2 * pad;
    var X = function (p) { return pad + (p.lng * kx - x1) * sc; }, Y = function (p) { return pad + (y2 - p.lat) * sc; };
    var vmax = Math.max.apply(null, punti.map(function (p) { return p.viaggi; }).concat([1])), c = '';
    punti.slice().sort(function (a, b) { return b.viaggi - a.viaggi; }).forEach(function (p) {
      c += '<circle cx="' + X(p).toFixed(1) + '" cy="' + Y(p).toFixed(1) + '" r="' + (2 + 9 * Math.sqrt(p.viaggi / vmax)).toFixed(1) + '" fill="' + GRIGIO + '" fill-opacity="0.45" stroke="#fff" stroke-width="0.5"><title>' +
        esc(p.codice + ' ' + p.nome + ': ' + p.viaggi + ' viaggi') + '</title></circle>';
    });
    sedi.forEach(function (s, i) {
      var x = X(s), y = Y(s);
      c += '<rect x="' + (x - 6) + '" y="' + (y - 6) + '" width="12" height="12" transform="rotate(45 ' + x + ' ' + y + ')" fill="' + colore(s.codice) + '" stroke="#fff" stroke-width="1.5"><title>' + esc(s.nome) + '</title></rect>';
      var dx = s.codice === 'OPZ2' ? -10 : 10, anchor = s.codice === 'OPZ2' ? 'end' : 'start', dy = [-10, 4, 18, 32, 46][i] || 4;
      c += testo(x + dx, y + dy, s.nome, { size: 12, fill: colore(s.codice), weight: 600, anchor: anchor });
    });
    return svg(w, Math.round(h), c, titolo) + '<p class="muted">Cerchi grigi: clienti, area proporzionale ai viaggi nel periodo. Rombi: sedi. Proiezione semplificata, senza strade.</p>';
  }

  function tessere(sedi) {
    return '<div class="kpi">' + sedi.map(function (s) {
      var d = s.codice === 'ATTUALE';
      return '<div class="tessera" style="border-top-color:' + colore(s.codice) + '"><div class="t-nome">' + esc(s.nome) + '</div>' +
        '<div class="t-val">' + fmt(s.costoAnno / 1e6, 2) + ' M€<span class="t-u"> / anno</span></div>' +
        '<div class="t-d ' + (d ? '' : s.deltaAnno < 0 ? 'neg' : 'pos') + '">' + (d ? 'riferimento' : segno(s.deltaAnno, 0, ' €') + ' (' + segno(s.deltaPct, 1, '%') + ')') + '</div>' +
        '<div class="t-sub">CO₂ ' + fmt(s.co2Anno, 0) + ' t/anno' + (d ? '' : ' · ' + segno(s.deltaCo2, 0, ' t')) + '</div>' +
        '<div class="t-sub">Gasolio ' + fmt(s.adeguamentoAnno, 0) + ' €/anno</div></div>';
    }).join('') + '</div>';
  }

  function disegna(el, D) {
    if (!D || !D.sedi.length) { el.innerHTML = '<div class="card"><span class="muted">Importare i viaggi reali e calcolare le distanze per vedere la dashboard.</span></div>'; return; }
    var cand = D.sedi.filter(function (s) { return s.codice !== 'ATTUALE'; });
    var h = '<div class="card"><h2>Sintesi</h2><p class="muted">' + fmt(D.periodo.viaggi, 0) + ' viaggi reali dal ' + esc(D.periodo.dal) + ' al ' + esc(D.periodo.al) + ' (' + D.periodo.giorni + ' giorni), ' +
      D.periodo.clienti + ' clienti, riportati all\'anno. Costi con tariffario e adeguamento gasolio.' + (D.nota ? ' ' + esc(D.nota) : '') + '</p>' +
      (D.mesiMancanti.length ? '<div class="alert warn">Prezzo del gasolio mancante per: ' + D.mesiMancanti.map(nomeMese).join(', ') + ' (adeguamento a zero in quei mesi).</div>' : '') + tessere(D.sedi) + '</div>';
    h += '<div class="card"><h2>Differenza di costo annuo rispetto all\'Interporto</h2>' +
      barreDelta(cand, function (r) { return r.deltaAnno; }, function (r) { return segno(r.deltaAnno, 0, ' €') + ' (' + segno(r.deltaPct, 1, '%') + ')'; }, 'Differenza di costo annuo') +
      '<p class="muted">Verde = risparmio, rosso = costo in più, grigio = punto di ottimo (riferimento teorico).</p></div>';
    h += '<div class="card"><h2>Differenza di CO₂ rispetto all\'Interporto</h2>' +
      barreDelta(cand, function (r) { return r.deltaCo2; }, function (r) { return segno(r.deltaCo2, 0, ' t') + ' (' + segno(r.deltaCo2Pct, 1, '%') + ')'; }, 'Differenza di CO2') + '</div>';
    if (D.mesi.length > 1) h += '<div class="card"><h2>Stabilità mese per mese</h2>' + lineeMensili(D.mesi, D.sedi, 'Differenza percentuale mensile') +
      '<p class="muted">Differenza % del costo del mese (con gasolio) rispetto all\'Interporto: linee piatte = risultato stabile nei mesi.</p></div>';
    h += '<div class="card"><h2>Adeguamento gasolio</h2>' + barreGasolio(D.mesi, D.franchigia, 'Adeguamento gasolio mensile') + '</div>';
    h += '<div class="card"><h2>Dove sono clienti e sedi</h2>' + mappa(D.punti, D.sediPos, 'Mappa schematica') + '</div>';
    el.innerHTML = h;
  }

  root.Dashboard = { disegna: disegna, COLORI: COLORI };
})(typeof self !== 'undefined' ? self : this);
