const test = require('node:test');
const assert = require('node:assert');
const C = require('../js/calcolo.js');

const vicino = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≠ ${b}`);
const P = { euro_km: 1.45, km_fatturati: 'AR', capacita_pallet: 33, costo_fisso_viaggio: 0, settimane_anno: 50 };

test('num: formati italiani e inglesi, errori', () => {
  vicino(C.num('1,45'), 1.45); vicino(C.num('1.45'), 1.45); vicino(C.num('1.234,56'), 1234.56);
  vicino(C.num(' 33 '), 33); vicino(C.num('12 €'), 12); vicino(C.num(7), 7);
  assert.throws(() => C.num('abc', 'x'), /non valido per x/); assert.throws(() => C.num('')); assert.throws(() => C.num(NaN));
});

test('coordinate: formati, inversione lat/lng, errori', () => {
  assert.deepStrictEqual(C.leggiCoordinate('44.4949, 11.3426'), { lat: 44.4949, lng: 11.3426 });
  assert.deepStrictEqual(C.leggiCoordinate('44,4949; 11,3426'), { lat: 44.4949, lng: 11.3426 });
  assert.deepStrictEqual(C.leggiCoordinate('11.3426 44.4949'), { lat: 44.4949, lng: 11.3426 });
  assert.strictEqual(C.leggiCoordinate('  '), null);
  assert.throws(() => C.leggiCoordinate('Bologna'), /non valide/); assert.throws(() => C.leggiCoordinate('100, 200'), /fuori scala/);
});

test('metriche: calcolo a mano', () => {
  // 50 pallet in 3 consegne = 16,67 per consegna -> 1 viaggio per consegna -> 3 viaggi/settimana
  const m = C.metriche({ pallet: 50, consegne: 3 }, { capacita: null }, { km: 40, minuti: 35 }, P);
  assert.strictEqual(m.viaggiSett, 3);
  vicino(m.costoViaggio, 80 * 1.45); vicino(m.costoSett, 3 * 80 * 1.45); vicino(m.costoAnno, 3 * 80 * 1.45 * 50); vicino(m.kmSett, 240);
  // 66 pallet in 2 consegne = 33 esatti -> 1 viaggio (niente errore di arrotondamento)
  assert.strictEqual(C.metriche({ pallet: 66, consegne: 2 }, null, { km: 1, minuti: 1 }, P).viaggiSett, 2);
  // 99 in 3 con mezzo da 18 -> ceil(33/18)=2 per consegna -> 6
  assert.strictEqual(C.metriche({ pallet: 99, consegne: 3 }, { capacita: 18 }, { km: 1, minuti: 1 }, P).viaggiSett, 6);
  // solo andata e costo fisso
  const m2 = C.metriche({ pallet: 10, consegne: 1 }, null, { km: 100, minuti: 0 }, Object.assign({}, P, { km_fatturati: 'A', costo_fisso_viaggio: 25 }));
  vicino(m2.costoViaggio, 100 * 1.45 + 25);
});

test('delta rispetto all\'attuale', () => {
  const a = C.metriche({ pallet: 50, consegne: 3 }, null, { km: 40, minuti: 0 }, P);
  const b = C.metriche({ pallet: 50, consegne: 3 }, null, { km: 50, minuti: 0 }, P);
  const d = C.delta(b, a);
  vicino(d.km, 10); vicino(d.pct, 25); assert.strictEqual(d.viaggiSett, 0);
  assert.strictEqual(C.delta(null, a), null);
});

function costoPeso(pts, lat, lng) {
  const W = pts.reduce((s, p) => s + p.w, 0), lat0 = pts.reduce((s, p) => s + p.w * p.lat, 0) / W;
  const kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.574;
  return pts.reduce((s, p) => s + p.w * Math.hypot((p.lng - lng) * kx, (p.lat - lat) * ky), 0);
}

test('Weiszfeld: coincide con il minimo di una ricerca a griglia fine', () => {
  const pts = [[44.6, 10.9, 3], [44.7, 10.6, 9], [44.8, 10.3, 2], [44.84, 11.62, 2], [44.35, 11.71, 3], [44.22, 12.04, 3], [44.42, 12.2, 12], [44.07, 12.57, 3], [44.14, 12.24, 1], [44.78, 10.89, 2]].map(a => ({ lat: a[0], lng: a[1], w: a[2] }));
  const o = C.weiszfeld(pts);
  let best = Infinity, bl, bg;
  for (let la = 44.0; la <= 44.9; la += 0.005) for (let ln = 10.2; ln <= 12.7; ln += 0.005) { const c = costoPeso(pts, la, ln); if (c < best) { best = c; bl = la; bg = ln; } }
  for (let la = bl - 0.006; la <= bl + 0.006; la += 0.0001) for (let ln = bg - 0.006; ln <= bg + 0.006; ln += 0.0001) best = Math.min(best, costoPeso(pts, la, ln));
  assert.ok(costoPeso(pts, o.lat, o.lng) <= best * (1 + 1e-6));
});

test('Weiszfeld: casi limite (peso dominante, allineati, singolo, vuoto)', () => {
  let o = C.weiszfeld([{ lat: 44.5, lng: 11.3, w: 100 }, { lat: 44.6, lng: 11.0, w: 1 }, { lat: 44.3, lng: 11.6, w: 1 }]);
  vicino(o.lat, 44.5, 1e-6); vicino(o.lng, 11.3, 1e-6);
  o = C.weiszfeld([{ lat: 44, lng: 11, w: 1 }, { lat: 44, lng: 11.5, w: 1 }, { lat: 44, lng: 12, w: 1 }]);
  vicino(o.lng, 11.5, 1e-6);
  o = C.weiszfeld([{ lat: 44, lng: 11, w: 5 }]); vicino(o.lat, 44);
  assert.throws(() => C.weiszfeld([]), /Servono/);
});

test('tabella, riepilogo, estrazione e CSV coerenti', () => {
  const sedi = {
    ATTUALE: { codice: 'ATTUALE', nome: 'A', indirizzo: 'x', lat: 44, lng: 11, capacita: null },
    OPZ1: { codice: 'OPZ1', nome: 'B', indirizzo: 'y', lat: 44.1, lng: 11.1, capacita: null },
    OPZ2: { codice: 'OPZ2', nome: 'C', lat: null, lng: null }, OPZ3: { codice: 'OPZ3', lat: null }, OTTIMO: { codice: 'OTTIMO', lat: null }
  };
  const pv = [{ codice: '001', nome: 'P1', lat: 44.2, lng: 11.2, pallet: 50, consegne: 3 }, { codice: '002', nome: 'P;2', lat: 44.3, lng: 11.0, pallet: 70, consegne: 2 }];
  const dist = [];
  ['ATTUALE', 'OPZ1'].forEach((s, i) => pv.forEach((p, j) => dist.push({ sede: s, pv: p.codice, km: 10 + i * 5 + j, minuti: 10, chiave: C.chiaveCoord(sedi[s], p) })));
  const t = C.tabella(P, sedi, pv, dist);
  assert.deepStrictEqual(t.attive, ['ATTUALE', 'OPZ1']);
  const r = C.riepilogo(P, sedi, t);
  vicino(r[0].costoAnno, t.righe[0].m.ATTUALE.costoAnno + t.righe[1].m.ATTUALE.costoAnno);
  vicino(r[1].deltaAnno, r[1].costoAnno - r[0].costoAnno);
  const e = C.estrazione(P, sedi, t);
  assert.strictEqual(e.righe.length, 4); e.righe.forEach(x => assert.strictEqual(x.length, e.intestazione.length));
  const csv = C.csv(e);
  assert.ok(csv.startsWith('﻿Sede;'));
  assert.ok(csv.includes('"P;2"'), 'campo con ; tra virgolette');
  // distanza con chiave vecchia = mancante
  dist[0].chiave = 'vecchia';
  assert.strictEqual(C.tabella(P, sedi, pv, dist).tot.ATTUALE.mancanti, 1);
  assert.throws(() => C.estrazione(P, sedi, C.tabella(P, sedi, pv, dist)), /Mancano 1 distanze/);
});

test('leggiCSV: separatori, virgolette, BOM, righe finali', () => {
  assert.deepStrictEqual(C.leggiCSV('﻿a;b\r\n1;"x;y"\r\n'), [['a', 'b'], ['1', 'x;y']]);
  assert.deepStrictEqual(C.leggiCSV('a,b\n"he said ""ok""",2'), [['a', 'b'], ['he said "ok"', '2']]);
  assert.deepStrictEqual(C.leggiCSV('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepStrictEqual(C.leggiCSV('a;b\n"riga\nsu due";3'), [['a', 'b'], ['riga\nsu due', '3']]);
});

test('import: riconoscimento colonne grezze, composizione indirizzo, scarti', () => {
  const righe = [
    [], ['Cod. PV', 'Insegna', 'Via', 'CAP', 'Città', 'Prov', 'Pallet settimana', 'Consegne/settimana'],
    ['1.0', 'Modena', 'Via Modena 10', '41121', 'Modena', 'mo', '50', '3'],
    ['002', 'Carpi', 'Via Carpi 1, Carpi', '41012', 'Carpi', 'MO', '20,5', '2'],
    ['', 'senza codice', 'Via X', '', 'Y', '', '5', '1'],
    ['002', 'duplicato', 'Via Z', '', 'Z', '', '5', '1'],
    ['004', 'zero', 'Via Z', '', 'Z', '', '0', '1'],
    ['005', 'troppe', 'Via Z', '', 'Z', '', '10', '30'],
    ['006', 'testo', 'Via Z', '', 'Z', '', 'tanti', '1'],
    ['', '', '', '', '', '', '', '']
  ];
  const r = C.preparaImport(righe);
  assert.strictEqual(r.validi.length, 2);
  assert.strictEqual(r.validi[0].codice, '1');
  assert.strictEqual(r.validi[0].indirizzo, 'Via Modena 10, 41121 Modena (MO)');
  assert.strictEqual(r.validi[1].indirizzo, 'Via Carpi 1, Carpi', 'comune già presente: non duplicato');
  vicino(r.validi[1].pallet, 20.5);
  assert.deepStrictEqual(r.scartati.map(s => s.riga), [5, 6, 7, 8, 9]);
  assert.match(r.scartati[1].motivo, /duplicato/);
  assert.match(r.scartati[3].motivo, /non plausibili/);
  assert.throws(() => C.preparaImport([['nome', 'indirizzo']]), /Colonne non riconosciute: codice, pallet, consegne/);
  const coord = C.preparaImport([['codice', 'lat', 'lon', 'pallet', 'consegne'], ['A', '44.5', '11.3', '5', '1']]);
  assert.deepStrictEqual(coord.validi[0].pos, { lat: 44.5, lng: 11.3 });
});

test('carichi giornalieri: viaggi giorno per giorno, non sulla media', () => {
  // 2 giorni: 30 e 40 pallet; mezzo da 33 -> 1 + 2 = 3 viaggi (con la media 35/giorno sarebbero 4)
  const carichi = [
    { pv: 'A', data: '2026-03-03', reparto: 'ortofrutta', colli: 600 }, { pv: 'A', data: '2026-03-03', reparto: 'carne', colli: 300 },   // 20 + 10 = 30 pallet
    { pv: 'A', data: '2026-03-04', reparto: 'ortofrutta', colli: 800 }, { pv: 'A', data: '2026-03-04', reparto: 'carne', colli: 300 }    // 26,67 + 10 = 36,67
  ];
  const v = C.volumi(carichi, { ortofrutta: 30, carne: 30 }, 6);
  assert.strictEqual(v.giorni, 2); vicino(v.settimane, 2 / 6);
  const pv = { codice: 'A', carico: v.perPV.A };
  const m = C.metriche(pv, null, { km: 50, minuti: 40 }, P);
  vicino(m.viaggiSett, 3 / (2 / 6));           // 9 viaggi/settimana
  vicino(m.palletSett, (30 + 36.6666667) / (2 / 6), 1e-6);
  vicino(m.consegneSett, 6);
  vicino(m.costoAnno, 9 * 100 * 1.45 * 50);
  // capacità ridotta sulla sede: 18 pallet -> 2 + 3 = 5 viaggi
  vicino(C.metriche(pv, { capacita: 18 }, { km: 50, minuti: 40 }, P).viaggiSett, 15);
  // fattore mancante: PV senza volumi, escluso dai totali
  const v2 = C.volumi(carichi, { ortofrutta: 30 }, 6);
  assert.deepStrictEqual(v2.repartiSenzaFattore, ['carne']);
  assert.strictEqual(v2.perPV.A, null);
  assert.strictEqual(C.metriche({ carico: null }, null, { km: 1, minuti: 1 }, P), null);
  const sedi = { ATTUALE: { codice: 'ATTUALE', nome: 'X', lat: 41, lng: 16 }, OPZ1: { lat: null }, OPZ2: { lat: null }, OPZ3: { lat: null }, OTTIMO: { lat: null } };
  const t = C.tabella(P, sedi, [{ codice: 'A', lat: 41.1, lng: 16.1, carico: null }], []);
  assert.strictEqual(t.senzaVolumi.length, 1); assert.strictEqual(t.righe.length, 0);
});

test('pulizia indirizzi e lettura date', () => {
  assert.strictEqual(C.pulisciIndirizzo('VIA ARNALDO SPALTRO,S.N.'), 'VIA ARNALDO SPALTRO');
  assert.strictEqual(C.pulisciIndirizzo('VIALE PITAGORA, S.N.C.'), 'VIALE PITAGORA');
  assert.strictEqual(C.pulisciIndirizzo('VIA MARCONI ANG. DE GASPERI, N.C.'), 'VIA MARCONI');
  assert.strictEqual(C.pulisciIndirizzo('  VIA   SNOOPY 3 '), 'VIA SNOOPY 3');
  assert.strictEqual(C.pulisciIndirizzo("CIRCONVALLAZ. CONCA D'ORO 145"), "CIRCONVALLAZ. CONCA D'ORO 145");
  assert.strictEqual(C.leggiData(new Date('2026-03-02T00:00:00Z')), '2026-03-02');
  assert.strictEqual(C.leggiData('2/3/2026'), '2026-03-02');
  assert.strictEqual(C.leggiData('2026-03-04T00:00:00.000Z'), '2026-03-04');
  assert.strictEqual(C.leggiData('LUN'), null);
});

test('import carichi giornalieri formato largo (riga titolo, una riga per reparto, colonne-data)', () => {
  const righe = [
    ['INTERPORTO', 'LOGISTICA AGGIORNATA'],
    ['codcli', 'RAGIONE   SOCIALE', 'INDIRIZZO', 'CITTA', 'PROVINCIA_RIC', 'mag', 'INSEGNA', 'LUN', 'MAR', '2026-03-02', '2026-03-03', '2026-03-04'],
    [100, 'ALFA SRL      ', 'VIA ROMA, S.N.', 'BARI', 'BA', 'ortofrutta', 'DOK', 'X', 'X', '', 30, 40],
    [100, 'ALFA SRL      ', 'VIA ROMA, S.N.', 'BARI', 'BA', 'carne', 'DOK', 'X', '', '', 5, 'X'],
    [100, 'ALFA SRL      ', 'VIA ROMA, S.N.', 'BARI', 'BA', 'surgelati ', 'DOK', 'X', '', '', '', ''],
    [200, 'BETA', 'VIA MARE 2', 'MOLFETTA', 'BA', 'ortofrutta', 'A&O', 'X', 'X', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', '']
  ];
  const p = C.preparaImport(righe);
  assert.strictEqual(p.tipo, 'giornaliero');
  assert.deepStrictEqual(p.validi.map(v => [v.codice, v.nome, v.indirizzo]), [['100', 'ALFA SRL', 'VIA ROMA, BARI (BA)'], ['200', 'BETA', 'VIA MARE 2, MOLFETTA (BA)']]);
  assert.deepStrictEqual(p.date, ['2026-03-03', '2026-03-04']);
  assert.deepStrictEqual(p.reparti, ['carne', 'ortofrutta']);
  assert.strictEqual(p.carichi.length, 3);
  assert.match(p.scartati[0].motivo, /non numerica "X" il 2026-03-04 \(carne\)/);
  assert.match(p.avvisi.find(a => a.codice === '200').motivo, /nessun carico/);
});

test('import carichi giornalieri formato lungo (data + colli)', () => {
  const p = C.preparaImport([
    ['Codice cliente', 'Ragione sociale', 'Indirizzo', 'Comune', 'Prov', 'Reparto', 'Data', 'Colli'],
    ['A1', 'Uno', 'Via A 1', 'Bari', 'BA', 'Ortofrutta', '03/03/2026', '12'],
    ['A1', 'Uno', 'Via A 1', 'Bari', 'BA', 'ortofrutta', '03/03/2026', '8'],
    ['A1', 'Uno', 'Via A 1', 'Bari', 'BA', 'carne', 'ieri', '8']
  ]);
  assert.strictEqual(p.tipo, 'giornaliero');
  assert.deepStrictEqual(p.carichi, [{ pv: 'A1', data: '2026-03-03', reparto: 'ortofrutta', colli: 20 }]);
  assert.match(p.scartati[0].motivo, /data non valida/);
});
