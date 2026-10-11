/* Simulatore CEDI — scheda Dashboard: KPI per sede, confronti, andamento mensile, gasolio, mappa schematica.
   Stile dei grafici "Excel 97": area del grafico grigia, serie glicine / prugna / giallino con bordo nero, legenda in riquadro.
   Solo disegno (SVG generato da dati già calcolati): nessun accesso al database. */
(function (root) {
  'use strict';

  // Tavolozza classica dei grafici di Excel 97
  var COLORI = { ATTUALE: '#808080', OPZ1: '#9999FF', OPZ2: '#993366', OPZ3: '#CCFFFF', OTTIMO: '#FFFFCC' };
  var AREA = '#C0C0C0', BORDO = '#000000', GRIGLIA = '#000000', TESTO = '#000000', MUTO = '#444444';
  var FONT = 'Arial, Helvetica, sans-serif';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(x, d) {
    if (x == null || isNaN(x)) return '—';
    var p = Math.abs(Number(x)).toFixed(d || 0).split('.');
    p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (Number(x) < 0 && Number(p.join('.')) !== 0 ? '−' : '') + p.join(',');
  }
  function segno(x, d, suff) { return x == null || isNaN(x) ? '—' : (x > 0 ? '+' : '') + fmt(x, d) + (suff || ''); }
  function colore(c) { return COLORI[c] || '#CCCCFF'; }
  function nomeMese(k) { var n = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic']; return n[Number(k.slice(5, 7)) - 1] + ' ' + k.slice(2, 4); }
  function testo(x, y, t, o) {
    o = o || {};
    return '<text x="' + x + '" y="' + y + '" font-family="' + FONT + '" font-size="' + (o.size || 12) + '" fill="' + (o.fill || TESTO) + '"' + (o.anchor ? ' text-anchor="' + o.anchor + '"' : '') +
      (o.weight ? ' font-weight="' + o.weight + '"' : '') + '>' + esc(t) + '</text>';
  }
  function rett(x, y, w, h, fill, extra) { return '<rect x="' + x + '" y="' + y + '" width="' + Math.max(0, w) + '" height="' + Math.max(0, h) + '" fill="' + fill + '" stroke="' + BORDO + '" stroke-width="1"' + (extra || '') + '/>'; }
  function svg(w, h, corpo, titolo) { return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" role="img" aria-label="' + esc(titolo) + '" style="max-width:' + w + 'px;display:block;background:#fff">' + corpo + '</svg>'; }

  /** Legenda in riquadro, come in Excel: voci [{nome, colore, tipo:'barra'|'linea'|'rombo'|'cerchio'}]. */
  function legenda(x, y, voci) {
    var h = 10 + voci.length * 20, w = 12 + Math.max.apply(null, voci.map(function (v) { return v.nome.length; })) * 7 + 30, c = rett(x, y, w, h, '#FFFFFF');
    voci.forEach(function (v, i) {
      var yy = y + 8 + i * 20;
      if (v.tipo === 'linea') c += '<line x1="' + (x + 8) + '" x2="' + (x + 28) + '" y1="' + (yy + 6) + '" y2="' + (yy + 6) + '" stroke="' + v.colore + '" stroke-width="3"' + (v.tratteggio ? ' stroke-dasharray="4 3"' : '') + '/>' +
        '<rect x="' + (x + 14) + '" y="' + yy + '" width="8" height="8" fill="' + v.colore + '" stroke="#000"/>';
      else if (v.tipo === 'rombo') c += '<rect x="' + (x + 13) + '" y="' + (yy + 1) + '" width="10" height="10" fill="' + v.colore + '" stroke="#000" transform="rotate(45 ' + (x + 18) + ' ' + (yy + 6) + ')"/>';
      else if (v.tipo === 'cerchio') c += '<circle cx="' + (x + 18) + '" cy="' + (yy + 6) + '" r="5" fill="' + v.colore + '" stroke="#000"/>';
      else c += rett(x + 10, yy, 16, 12, v.colore);
      c += testo(x + 34, yy + 10, v.nome, { size: 12 });
    });
    return { svg: c, w: w, h: h };
  }

  /** Barre orizzontali attorno allo zero (Interporto = 0), area grigia, legenda a destra. */
  function barreDelta(righe, valore, etichetta, titolo, unita) {
    var w = 860, sx = 20, larg = 600, top = 34, alt = 34, h = top + righe.length * (alt + 14) + 40;
    var vals = righe.map(valore), lo = Math.min(0, Math.min.apply(null, vals)), hi = Math.max(0, Math.max.apply(null, vals));
    var pad = (hi - lo) * 0.18 || 1; lo = lo < 0 ? lo - pad : lo; hi = hi > 0 ? hi + pad : hi;
    var x = function (v) { return sx + (v - lo) / (hi - lo) * larg; }, x0 = x(0);
    var y1 = h - 34, c = testo(sx, 18, titolo, { size: 13, weight: 'bold' });
    c += rett(sx, top - 8, larg, y1 - top + 8, AREA);
    // griglia verticale
    var passo = Math.pow(10, Math.floor(Math.log10((hi - lo) / 4))), k = (hi - lo) / passo > 8 ? 2 : 1; passo *= k;
    for (var t = Math.ceil(lo / passo) * passo; t <= hi; t += passo) {
      c += '<line x1="' + x(t) + '" x2="' + x(t) + '" y1="' + (top - 8) + '" y2="' + y1 + '" stroke="' + GRIGLIA + '" stroke-width="' + (Math.abs(t) < passo / 1000 ? 1.5 : 0.4) + '"/>';
      c += testo(x(t), y1 + 15, fmt(t, 0) + (unita || ''), { size: 11, anchor: 'middle', fill: MUTO });
    }
    righe.forEach(function (r, i) {
      var v = valore(r), y = top + i * (alt + 14), xa = Math.min(x(v), x0), wd = Math.max(1, Math.abs(x(v) - x0));
      c += '<rect x="' + xa + '" y="' + y + '" width="' + wd + '" height="' + alt + '" fill="' + colore(r.codice) + '" stroke="#000"><title>' + esc(r.nome + ': ' + etichetta(r)) + '</title></rect>';
      c += testo(v < 0 ? xa - 6 : x(v) + 6, y + alt / 2 + 4, etichetta(r), { size: 12, anchor: v < 0 ? 'end' : 'start', weight: 'bold' });
    });
    c += testo(x0, h - 4, '0 = Interporto (sede attuale)', { size: 11, anchor: 'middle', fill: MUTO });
    var L = legenda(sx + larg + 16, top - 8, righe.map(function (r) { return { nome: r.nome, colore: colore(r.codice) }; }));
    return svg(w, h, c + L.svg, titolo);
  }

  /** Linee del Δ% mensile di ogni sede candidata rispetto all'Interporto. */
  function lineeMensili(mesi, sedi, titolo) {
    var cand = sedi.filter(function (s) { return s.codice !== 'ATTUALE'; });
    var punti = cand.map(function (s) {
      return mesi.map(function (m) { var a = m.sedi.ATTUALE, x = m.sedi[s.codice]; return a && x && a.costoTot ? (x.costoTot - a.costoTot) / a.costoTot * 100 : null; });
    });
    var tutti = [].concat.apply([0], punti).filter(function (v) { return v != null; });
    var lo = Math.floor(Math.min.apply(null, tutti) - 1), hi = Math.ceil(Math.max.apply(null, tutti) + 1);
    var w = 860, sx = 56, ex = 620, y0 = 34, y1 = 250, h = 290;
    var X = function (i) { return mesi.length < 2 ? (sx + ex) / 2 : sx + 40 + i * (ex - sx - 80) / (mesi.length - 1); };
    var Y = function (v) { return y1 - (v - lo) / (hi - lo) * (y1 - y0); };
    var c = testo(sx, 18, titolo, { size: 13, weight: 'bold' }) + rett(sx, y0, ex - sx, y1 - y0, AREA), passo = Math.max(1, Math.ceil((hi - lo) / 7));
    for (var t = Math.ceil(lo / passo) * passo; t <= hi; t += passo) {
      c += '<line x1="' + sx + '" x2="' + ex + '" y1="' + Y(t) + '" y2="' + Y(t) + '" stroke="' + GRIGLIA + '" stroke-width="' + (t === 0 ? 1.5 : 0.4) + '"/>';
      c += testo(sx - 6, Y(t) + 4, segno(t, 0, '%'), { size: 11, fill: MUTO, anchor: 'end' });
    }
    mesi.forEach(function (m, i) { c += testo(X(i), y1 + 16, nomeMese(m.mese), { size: 11, fill: MUTO, anchor: 'middle' }); });
    cand.forEach(function (s, k) {
      var pts = punti[k].map(function (v, i) { return v == null ? null : [X(i), Y(v), v, i]; }).filter(Boolean);
      if (!pts.length) return;
      c += '<polyline fill="none" stroke="#000" stroke-width="4.5" points="' + pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' ') + '"/>';
      c += '<polyline fill="none" stroke="' + colore(s.codice) + '" stroke-width="3" points="' + pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' ') + '"/>';
      pts.forEach(function (p) {
        c += '<rect x="' + (p[0] - 4) + '" y="' + (p[1] - 4) + '" width="8" height="8" fill="' + colore(s.codice) + '" stroke="#000"><title>' + esc(s.nome + ', ' + nomeMese(mesi[p[3]].mese) + ': ' + segno(p[2], 1, '%')) + '</title></rect>';
        c += testo(p[0], p[1] - 9, segno(p[2], 1, '%'), { size: 11, anchor: 'middle', weight: 'bold' });
      });
    });
    var L = legenda(ex + 16, y0, cand.map(function (s) { return { nome: s.nome, colore: colore(s.codice), tipo: 'linea' }; }));
    return svg(w, h, c + L.svg, titolo);
  }

  /** Adeguamento gasolio: barre raggruppate per mese (€ per sede) con % applicata e prezzo del mese sopra ogni gruppo. */
  function barreGasolio(mesi, sedi, franchigia, titolo) {
    var cod = sedi.map(function (s) { return s.codice; });
    var w = 860, sx = 70, ex = 620, y0 = 56, y1 = 250, h = 300;
    var vals = []; mesi.forEach(function (m) { cod.forEach(function (c) { if (m.sedi[c]) vals.push(m.sedi[c].adeguamento); }); });
    var hi = Math.max.apply(null, vals.concat([1])), lo = Math.min.apply(null, vals.concat([0]));
    var passo = Math.pow(10, Math.floor(Math.log10(Math.max(hi - lo, 1) / 4))); if ((hi - lo) / passo > 8) passo *= 2; if ((hi - lo) / passo > 8) passo *= 2.5;
    hi = Math.ceil(hi / passo) * passo; lo = Math.floor(lo / passo) * passo;
    var Y = function (v) { return y1 - (v - lo) / (hi - lo || 1) * (y1 - y0); };
    var c = testo(sx, 18, titolo, { size: 13, weight: 'bold' }) + rett(sx, y0, ex - sx, y1 - y0, AREA);
    for (var t = lo; t <= hi + 1e-9; t += passo) {
      c += '<line x1="' + sx + '" x2="' + ex + '" y1="' + Y(t) + '" y2="' + Y(t) + '" stroke="' + GRIGLIA + '" stroke-width="' + (t === 0 ? 1.5 : 0.4) + '"/>';
      c += testo(sx - 6, Y(t) + 4, fmt(t, 0) + ' €', { size: 11, fill: MUTO, anchor: 'end' });
    }
    var gw = (ex - sx) / Math.max(1, mesi.length), bw = Math.min(26, gw * 0.75 / cod.length);
    mesi.forEach(function (m, i) {
      var cx = sx + (i + 0.5) * gw, x0 = cx - bw * cod.length / 2;
      cod.forEach(function (c2, j) {
        var x = m.sedi[c2]; if (!x) return;
        var v = x.adeguamento, ya = Math.min(Y(v), Y(0)), hh = Math.abs(Y(v) - Y(0));
        c += '<rect x="' + (x0 + j * bw) + '" y="' + ya + '" width="' + bw + '" height="' + Math.max(0.5, hh) + '" fill="' + colore(c2) + '" stroke="#000"><title>' +
          esc(sedi[j].nome + ', ' + nomeMese(m.mese) + ': ' + fmt(v, 0) + ' € di adeguamento') + '</title></rect>';
      });
      c += testo(cx, y0 - 22, m.mancante ? 'prezzo n.d.' : segno(m.adeguamento * 100, 2, '%') + ' tariffa', { size: 11, anchor: 'middle', weight: 'bold' });
      c += testo(cx, y0 - 8, m.mancante ? '' : fmt(m.prezzo, 3) + ' €/l', { size: 11, anchor: 'middle', fill: MUTO });
      c += testo(cx, y1 + 16, nomeMese(m.mese), { size: 11, fill: MUTO, anchor: 'middle' });
    });
    var L = legenda(ex + 16, y0, sedi.map(function (s) { return { nome: s.nome, colore: colore(s.codice) }; }));
    return svg(w, h, c + L.svg, titolo) +
      '<p class="muted">Come si legge: ogni mese il prezzo medio del gasolio (MIT, netto IVA e rimborso accise; numero sopra il gruppo) si confronta con il riferimento di 1,289 €/l. ' +
      'Dalla variazione si toglie la franchigia del ' + fmt(franchigia * 100, 0) + '% e il resto si applica al 30% della tariffa: è la percentuale in grassetto. ' +
      'Le barre mostrano quanti euro di adeguamento si pagano ai vettori in quel mese partendo da ciascuna sede: più km, più adeguamento.</p>';
  }

  /** Mappa schematica: clienti (cerchi ∝ viaggi) e sedi, in proiezione locale; zoomKm = riquadro attorno alle sedi. */
  function mappa(punti, sedi, titolo, zoomKm) {
    if (zoomKm) {
      var la = sedi.map(function (q) { return q.lat; }), lo = sedi.map(function (q) { return q.lng; });
      var dLat = zoomKm / 110.574, dLng = zoomKm / (111.320 * Math.cos(la[0] * Math.PI / 180));
      var b = { a1: Math.min.apply(null, la) - dLat, a2: Math.max.apply(null, la) + dLat, o1: Math.min.apply(null, lo) - dLng, o2: Math.max.apply(null, lo) + dLng };
      punti = punti.filter(function (q) { return q.lat >= b.a1 && q.lat <= b.a2 && q.lng >= b.o1 && q.lng <= b.o2; });
      punti = punti.concat([{ lat: b.a1, lng: b.o1, viaggi: 0, cornice: true }, { lat: b.a2, lng: b.o2, viaggi: 0, cornice: true }]);
    }
    var tutti = punti.concat(sedi);
    if (!tutti.length) return '';
    var lat0 = tutti.reduce(function (s, p) { return s + p.lat; }, 0) / tutti.length, kx = Math.cos(lat0 * Math.PI / 180);
    var xs = tutti.map(function (p) { return p.lng * kx; }), ys = tutti.map(function (p) { return p.lat; });
    var x1 = Math.min.apply(null, xs), x2 = Math.max.apply(null, xs), y1 = Math.min.apply(null, ys), y2 = Math.max.apply(null, ys);
    var w = 520, pad = 18, sc = Math.min((w - 2 * pad) / (x2 - x1 || 1), 480 / (y2 - y1 || 1)), h = (y2 - y1) * sc + 2 * pad;
    var X = function (p) { return pad + (p.lng * kx - x1) * sc; }, Y = function (p) { return pad + (y2 - p.lat) * sc; };
    var vmax = Math.max.apply(null, punti.map(function (p) { return p.viaggi; }).concat([1]));
    var c = rett(0.5, 0.5, w - 1, h - 1, AREA);
    punti.filter(function (p) { return !p.cornice; }).sort(function (a, b) { return b.viaggi - a.viaggi; }).forEach(function (p) {
      c += '<circle cx="' + X(p).toFixed(1) + '" cy="' + Y(p).toFixed(1) + '" r="' + (2 + 8 * Math.sqrt(p.viaggi / vmax)).toFixed(1) + '" fill="#FFFFFF" fill-opacity="0.85" stroke="#000" stroke-width="0.6"><title>' +
        esc(p.codice + ' ' + p.nome + ': ' + p.viaggi + ' viaggi') + '</title></circle>';
    });
    sedi.forEach(function (s) {
      var x = X(s), y = Y(s);
      c += '<rect x="' + (x - 7) + '" y="' + (y - 7) + '" width="14" height="14" transform="rotate(45 ' + x + ' ' + y + ')" fill="' + colore(s.codice) + '" stroke="#000" stroke-width="1.2"><title>' + esc(s.nome) + '</title></rect>';
    });
    return svg(w, Math.round(h), c, titolo);
  }

  function tessere(sedi) {
    return '<div class="kpi">' + sedi.map(function (s) {
      var d = s.codice === 'ATTUALE';
      return '<div class="tessera" style="border-top-color:' + colore(s.codice) + '"><div class="t-nome"><span class="t-camp" style="background:' + colore(s.codice) + '"></span>' + esc(s.nome) + '</div>' +
        '<div class="t-val">' + fmt(s.costoAnno / 1e6, 2) + ' M€<span class="t-u"> / anno</span></div>' +
        '<div class="t-d">' + (d ? 'riferimento' : segno(s.deltaAnno, 0, ' €') + ' (' + segno(s.deltaPct, 1, '%') + ')') + '</div>' +
        '<div class="t-sub">CO₂ ' + fmt(s.co2Anno, 0) + ' t/anno' + (d ? '' : ' · ' + segno(s.deltaCo2, 0, ' t')) + '</div>' +
        '<div class="t-sub">Gasolio ' + fmt(s.adeguamentoAnno, 0) + ' €/anno</div></div>';
    }).join('') + '</div>';
  }

  function disegna(el, D) {
    if (!D || !D.sedi.length) { el.innerHTML = '<div class="card"><span class="muted">Importare i viaggi reali e calcolare le distanze per vedere la dashboard.</span></div>'; return; }
    var cand = D.sedi.filter(function (s) { return s.codice !== 'ATTUALE'; });
    var h = '<div class="card"><h2>Sintesi</h2><p class="muted">' + fmt(D.periodo.viaggi, 0) + ' viaggi reali dal ' + esc(D.periodo.dal) + ' al ' + esc(D.periodo.al) + ' (' + D.periodo.giorni + ' giorni), ' +
      D.periodo.clienti + ' clienti, riportati all\'anno. Costi con tariffario e adeguamento gasolio; differenze rispetto all\'Interporto.' + (D.nota ? ' ' + esc(D.nota) : '') + '</p>' +
      (D.mesiMancanti.length ? '<div class="alert warn">Prezzo del gasolio mancante per: ' + D.mesiMancanti.map(nomeMese).join(', ') + ' (adeguamento a zero in quei mesi).</div>' : '') + tessere(D.sedi) + '</div>';
    h += '<div class="card">' + barreDelta(cand, function (r) { return r.deltaAnno; }, function (r) { return segno(r.deltaAnno, 0, ' €') + ' (' + segno(r.deltaPct, 1, '%') + ')'; },
      'Differenza di costo annuo rispetto all\'Interporto (€/anno, gasolio incluso)', '') +
      '<p class="muted">Barre a sinistra dello zero = risparmio rispetto all\'Interporto; a destra = costo in più. Il punto di ottimo è un riferimento teorico.</p></div>';
    h += '<div class="card">' + barreDelta(cand, function (r) { return r.deltaCo2; }, function (r) { return segno(r.deltaCo2, 0, ' t') + ' (' + segno(r.deltaCo2Pct, 1, '%') + ')'; },
      'Differenza di CO₂ rispetto all\'Interporto (tonnellate/anno)', ' t') + '</div>';
    if (D.mesi.length > 1) h += '<div class="card">' + lineeMensili(D.mesi, D.sedi, 'Differenza % del costo mensile rispetto all\'Interporto (gasolio incluso)') +
      '<p class="muted">Ogni punto è un mese ricalcolato con i suoi viaggi e il suo prezzo del gasolio: linee piatte = risultato stabile.</p></div>';
    h += '<div class="card">' + barreGasolio(D.mesi, D.sedi, D.franchigia, 'Adeguamento gasolio pagato ai vettori, per mese e per sede (€)') + '</div>';
    var Lm = legenda(4, 4, [{ nome: 'Cliente (area ∝ viaggi)', colore: '#FFFFFF', tipo: 'cerchio' }].concat(D.sediPos.map(function (s) { return { nome: s.nome, colore: colore(s.codice), tipo: 'rombo' }; })));
    h += '<div class="card"><h2>Dove sono clienti e sedi</h2><div class="mappe"><div>' + mappa(D.punti, D.sediPos, 'Mappa schematica') + '</div><div><h3>Area di Bari</h3>' +
      mappa(D.punti, D.sediPos, 'Mappa ingrandita area di Bari', 10) + '</div></div>' +
      svg(Lm.w + 8, Lm.h + 8, Lm.svg, 'Legenda della mappa') + '<p class="muted">Proiezione semplificata, senza strade.</p></div>';
    el.innerHTML = h;
  }

  root.Dashboard = { disegna: disegna, COLORI: COLORI };
})(typeof self !== 'undefined' ? self : this);
