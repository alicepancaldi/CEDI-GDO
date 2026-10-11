// Test end-to-end: pagina reale (index.html + js) in un browser simulato, Supabase in memoria,
// funzione "ors" reale, OpenRouteService simulato.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const ExcelJS = require('exceljs');
const { JSDOM } = require('jsdom');
const C = require('../js/calcolo.js');
const { creaOrsFinto, caricaFunzioneOrs, creaSupabaseFinto, hav } = require('./helpers');

const RADICE = path.join(__dirname, '..');
const leggi = f => fs.readFileSync(path.join(RADICE, f), 'utf8');

function apriPagina({ config = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon' }, orsOpz = {}, sessione = null, supa } = {}) {
  const ors = creaOrsFinto(orsOpz);
  const S = supa || creaSupabaseFinto(caricaFunzioneOrs(ors.fetch), { sessione });
  const html = leggi('index.html').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://utente.github.io/simulatore-cedi/' });
  const w = dom.window;
  const errori = [];
  w.addEventListener('error', e => errori.push(e.message));
  w.console.error = (...a) => errori.push(a.join(' '));
  w.console.warn = () => {};
  w.TextDecoder = TextDecoder;
  w.confirm = () => w.__risposta !== false;
  w.__scaricati = [];
  w.URL.createObjectURL = b => { w.__blob = b; return 'blob:x'; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { w.__scaricati.push({ nome: this.download, blob: w.__blob }); };
  const leggiBlob = (b, modo) => new Promise(res => { const fr = new w.FileReader(); fr.onload = () => res(fr.result); fr[modo](b); });
  w.File.prototype.arrayBuffer = function () { return leggiBlob(this, 'readAsArrayBuffer'); };
  w.eval(fs.readFileSync(path.join(RADICE, 'js/vendor/exceljs-4.4.0.min.js'), 'utf8'));
  w.supabase = { createClient: () => S.client };
  w.eval('window.CONFIG = ' + JSON.stringify(Object.assign({ PAUSA_MATRICE_MS: 0, PAUSA_GEOCODIFICA_MS: 0, PAUSA_LIMITE_MS: 10 }, config)) + ';');
  w.eval(leggi('js/calcolo.js'));
  w.eval(leggi('js/app.js'));
  const d = w.document, $ = id => d.getElementById(id);
  const P = {
    w, d, $, ors, S, errori, leggiBlob,
    libero: () => !$('btnSalvaPV').disabled,
    set: (id, v) => { $(id).value = v; },
    async finche(cond, cosa, max = 8000) {
      const t = Date.now();
      while (!cond()) { if (Date.now() - t > max) throw new Error('Timeout: ' + cosa + ' | messaggio: ' + $('msg').textContent); await new Promise(r => setTimeout(r, 10)); }
    },
    async attendiMsg(re, cosa) { await P.finche(() => P.libero() && re.test($('msg').textContent), cosa || String(re)); },
    tab: t => d.querySelector(`#nav button[data-tab="${t}"]`).click(),
    async caricaFile(nome, contenuto, tipo) {
      const f = new w.File([contenuto], nome, { type: tipo || '' });
      Object.defineProperty($('fileImport'), 'files', { value: [f], configurable: true });
      $('fileImport').dispatchEvent(new w.Event('change'));
    }
  };
  return P;
}

test('configurazione mancante: messaggio chiaro', async () => {
  const p = apriPagina({ config: { SUPABASE_URL: '', SUPABASE_ANON_KEY: '' } });
  await p.finche(() => /Configurazione mancante/.test(p.$('msg').textContent), 'avviso configurazione');
});

test('flusso completo: login, sedi, PV, import, distanze, ottimo, estrazioni', async (t) => {
  const p = apriPagina({ orsOpz: { irraggiungibili: [[44.0678, 12.5695]] } });
  const { $, d, w, S } = p;

  await t.test('login: password errata respinta, corretta accettata', async () => {
    await p.finche(() => !$('tab-login').hidden, 'maschera login');
    p.set('loginEmail', 'alice@esempio.it'); p.set('loginPwd', 'sbagliata');
    $('formLogin').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await p.attendiMsg(/Email o password non corrette/);
    p.set('loginPwd', 'segreta');
    $('formLogin').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await p.finche(() => !$('tab-pv').hidden && p.libero() && $('pEuroKm').value === '1,30', 'dati caricati');
    assert.strictEqual($('utenteEmail').textContent, 'alice@esempio.it');
    assert.strictEqual($('pvCodice').value, '');
  });

  await t.test('parametri salvati con virgola decimale, valori errati respinti', async () => {
    p.tab('conf');
    p.set('pEuroKm', '1,45'); p.set('pSett', '50'); $('btnParam').click();
    await p.attendiMsg(/Parametri salvati/);
    assert.strictEqual(S.db.parametri[0].euro_km, 1.45); assert.strictEqual(S.db.parametri[0].settimane_anno, 50);
    p.set('pCap', '0'); $('btnParam').click();
    await p.attendiMsg(/capacità del mezzo/);
    assert.strictEqual(S.db.parametri[0].capacita_pallet, 33);
    p.set('pCap', '33');
  });

  async function salvaSede(i, nome, ind, coord, re) {
    const row = d.querySelectorAll('#sediForm .sede')[i];
    row.querySelector('.sNome').value = nome; row.querySelector('.sInd').value = ind;
    if (coord !== undefined) row.querySelector('.sCoord').value = coord;
    row.querySelector('.sSalva').click();
    await p.attendiMsg(re || /salvata/, 'sede ' + nome);
  }
  await t.test('sedi: geocodifica, avviso precisione, coordinate manuali, errore indirizzo', async () => {
    await salvaSede(0, 'CEDI Bologna', 'Via Emilia 1, Bologna');
    assert.match($('msg').textContent, /indirizzo esatto/);
    await salvaSede(1, 'Interporto', 'Interporto, Bentivoglio');
    await salvaSede(2, 'Modena', 'Via Modena 10, Modena');
    await salvaSede(3, 'Castel S. Pietro', 'Castel San Pietro Terme');
    assert.ok(d.querySelector('#msg .warn') && /solo comune: verificare/.test($('msg').textContent), 'avviso precisione comune');
    await salvaSede(3, 'Castel S. Pietro', 'Castel San Pietro Terme', '44.3901, 11.5950');
    assert.deepStrictEqual([S.db.sedi[3].lat, S.db.sedi[3].lng, S.db.sedi[3].geocodifica], [44.3901, 11.595, 'manuale']);
    await salvaSede(1, 'Interporto', 'Via inesistente 1', '', /Indirizzo non trovato/);
    assert.strictEqual(S.db.sedi[1].indirizzo, 'Interporto, Bentivoglio', 'sede invariata dopo errore');
    assert.strictEqual(S.db.sedi.filter(s => s.lat !== null).length, 4);
    assert.match(d.querySelectorAll('#sediForm .sede')[3].textContent, /coordinate inserite a mano/);
  });

  await t.test('maschera 1: nuovo PV, confronto con valori corretti', async () => {
    p.tab('pv');
    p.set('pvCodice', '001'); p.set('pvNome', 'Modena centro'); p.set('pvIndirizzo', 'Via Modena 10, Modena'); p.set('pvPallet', '50'); p.set('pvConsegne', '3');
    const prima = p.ors.st.matrix;
    $('btnSalvaPV').click();
    await p.attendiMsg(/Punto vendita 001 salvato/);
    assert.strictEqual(p.ors.st.matrix - prima, 1, 'una sola richiesta matrice per tutte le sedi');
    assert.strictEqual(S.db.distanze.length, 4);
    const ths = [...d.querySelectorAll('#confronto thead th')].slice(1).map(th => th.firstChild.textContent);
    assert.deepStrictEqual(ths, ['CEDI Bologna', 'Interporto', 'Modena', 'Castel S. Pietro']);
    const righe = Object.fromEntries([...d.querySelectorAll('#confronto tbody tr')].map(tr => [tr.cells[0].textContent, [...tr.cells].slice(1).map(c => c.textContent)]));
    assert.strictEqual(righe['Viaggi / settimana'][0], '3,0');
    const dist = S.db.distanze.find(x => x.sede === 'ATTUALE' && x.pv === '001');
    const atteso = Math.round(dist.km * 2 * 1.45 * 3 * 50);
    assert.strictEqual(righe['Costo / anno'][0], atteso.toLocaleString('it-IT') + ' €');
    assert.strictEqual(righe['Δ costo / anno'][0], '');
    assert.match(righe['Δ % costo'][2], /^-100,0 %$/, 'Modena coincide col PV');
    assert.ok(d.querySelector('#confronto .neg'));
  });

  await t.test('maschera 1: ricerca PV esistente, modifica senza nuova geocodifica, conferma su codice esistente', async () => {
    $('btnNuovoPV').click();
    p.set('pvCodice', '002'); p.set('pvIndirizzo', 'Via Ravenna 4, Ravenna'); p.set('pvPallet', '80'); p.set('pvConsegne', '4');
    $('btnSalvaPV').click(); await p.attendiMsg(/002 salvato/);
    p.set('pvCerca', '001'); $('pvCerca').dispatchEvent(new w.Event('change'));
    await p.finche(() => p.libero() && /^001/.test(d.querySelector('#confronto h2').textContent), 'confronto 001');
    assert.strictEqual($('pvPallet').value, '50');
    const geo = p.ors.st.geocode, mat = p.ors.st.matrix;
    p.set('pvPallet', '99'); $('btnSalvaPV').click(); await p.attendiMsg(/001 salvato/);
    assert.deepStrictEqual([p.ors.st.geocode, p.ors.st.matrix], [geo, mat], 'nessuna chiamata ORS se l\'indirizzo non cambia');
    assert.strictEqual(S.db.punti_vendita.find(x => x.codice === '001').pallet_settimana, 99);
    $('btnNuovoPV').click(); w.__risposta = false;
    p.set('pvCodice', '002'); p.set('pvIndirizzo', 'Via Ravenna 4, Ravenna'); p.set('pvPallet', '1'); p.set('pvConsegne', '1');
    $('btnSalvaPV').click(); await p.attendiMsg(/annullato/);
    assert.strictEqual(S.db.punti_vendita.find(x => x.codice === '002').pallet_settimana, 80);
    w.__risposta = true;
  });

  await t.test('maschera 1: coordinate manuali e validazioni', async () => {
    $('btnNuovoPV').click();
    p.set('pvCodice', '003'); p.set('pvIndirizzo', 'Magazzino senza indirizzo preciso'); p.set('pvPallet', '30'); p.set('pvConsegne', '2'); p.set('pvCoord', '44.80, 10.33');
    $('btnSalvaPV').click(); await p.attendiMsg(/003 salvato/);
    assert.strictEqual(S.db.punti_vendita.find(x => x.codice === '003').geocodifica, 'manuale');
    $('btnNuovoPV').click(); p.set('pvCodice', '004'); p.set('pvIndirizzo', 'Via Ferrara 7, Ferrara'); p.set('pvPallet', 'tanti'); p.set('pvConsegne', '2');
    $('btnSalvaPV').click(); await p.attendiMsg(/numerico non valido per pallet/);
    p.set('pvPallet', '20'); p.set('pvIndirizzo', 'Indirizzo inventato'); $('btnSalvaPV').click(); await p.attendiMsg(/Indirizzo non trovato/);
    assert.ok(!S.db.punti_vendita.some(x => x.codice === '004'));
  });

  await t.test('import da Excel con intestazioni grezze: anteprima, scarti, segnalazioni', async () => {
    p.tab('conf');
    const wb2 = new ExcelJS.Workbook(); const ws2 = wb2.addWorksheet('Negozi');
    ws2.addRow(['Cod. PV', 'Insegna', 'Via', 'CAP', 'Città', 'Prov', 'Pallet settimana', 'Consegne/settimana']);
    ws2.addRow([10, 'Carpi', 'Via Carpi 1', '41012', 'Carpi', 'MO', 22.5, 2]);
    ws2.addRow([11, 'Sassuolo', 'Via Sassuolo 2', '41049', 'Sassuolo', 'MO', 40, 3]);
    ws2.addRow([12, 'Vignola', 'Corso Vignola', '41058', 'Vignola', 'MO', 15, 1]);
    ws2.addRow([13, 'Ignoto', 'Via Mai Vista 3', '40100', 'Nessuno', 'BO', 15, 1]);
    ws2.addRow([14, 'Rimini', 'Via Rimini 8, Rimini', '', '', '', 99, 3]);
    ws2.addRow([10, 'Doppione', 'Via Carpi 1', '41012', 'Carpi', 'MO', 5, 1]);
    ws2.addRow(['', 'Senza codice', 'Via X', '', '', '', 5, 1]);
    ws2.addRow([15, 'Formula', 'Via Cesena 6, Cesena', '', '', '', { formula: '10*2', result: 20 }, 2]);
    const buf = await wb2.xlsx.writeBuffer();
    await p.caricaFile('negozi.xlsx', new Uint8Array(buf));
    await p.attendiMsg(/controllare l'anteprima/);
    assert.match($('anteprima').textContent, /6 righe valide \(6 nuovi punti vendita, 0 aggiornamenti\) · 2 righe scartate/);
    assert.match($('anteprima').textContent, /Via Carpi 1, 41012 Carpi \(MO\)/);
    $('btnConfermaImport').click();
    await p.attendiMsg(/Import completato/);
    assert.match($('anteprima').textContent, /5 punti vendita salvati, 2 segnalazioni/);
    assert.match($('anteprima').textContent, /Indirizzo non trovato/);
    assert.match($('anteprima').textContent, /solo comune: verificare/);
    assert.strictEqual(S.db.punti_vendita.find(x => x.codice === '15').pallet_settimana, 20, 'risultato della formula Excel');
    assert.strictEqual(S.db.punti_vendita.find(x => x.codice === '11').geocodifica, 'street');
    d.getElementById('btnProblemi').click();
    const csv = await p.leggiBlob(w.__scaricati.at(-1).blob, 'readAsText');
    assert.match(csv, /^﻿?Riga;Codice;Problema/); assert.strictEqual(csv.split('\r\n').length, 3);
  });

  await t.test('import CSV grande con coordinate (300 PV, separatore ;)', async () => {
    const righe = ['codice;nome;indirizzo;latitudine;longitudine;pallet/settimana;consegne/settimana'];
    for (let i = 0; i < 300; i++) righe.push(`B${String(i).padStart(3, '0')};Negozio ${i};Indirizzo ${i};${(44.0 + (i % 20) * 0.04).toFixed(4)};${(10.4 + Math.floor(i / 20) * 0.14).toFixed(4)};${10 + (i % 7) * 9};${1 + (i % 4)}`);
    await p.caricaFile('massivo.csv', righe.join('\r\n'), 'text/csv');
    await p.attendiMsg(/controllare l'anteprima/);
    assert.match($('anteprima').textContent, /300 righe valide/);
    const geo = p.ors.st.geocode;
    $('btnConfermaImport').click(); await p.attendiMsg(/Import completato/);
    assert.strictEqual(p.ors.st.geocode, geo, 'coordinate già presenti: nessuna geocodifica');
    assert.strictEqual(S.db.punti_vendita.length, 3 + 5 + 300);
  });

  await t.test('maschera 2: aggiorna distanze a blocchi, percorso non trovato segnalato', async () => {
    p.tab('riep');
    await p.finche(() => /Mancano/.test($('riepilogo').textContent), 'avviso distanze mancanti');
    const prima = p.ors.st.matrix;
    $('btnDist').click();
    await p.attendiMsg(/distanze calcolate, 4 non trovate/);
    const n = S.db.punti_vendita.length;
    assert.strictEqual(S.db.distanze.length, n * 4 - 4);
    assert.ok(p.ors.st.matrix - prima >= Math.ceil((n - 2) / 45) * 4, 'richieste a blocchi');
    assert.ok(p.ors.st.ultimaMatrice.locations.length <= 50);
    assert.match($('qualita').textContent, /Distanze non calcolate \(4\)/);
    assert.match($('qualita').textContent, /percorso per mezzi pesanti non trovato/);
    assert.match($('qualita').textContent, /Posizioni da verificare \(1\)/);
  });

  await t.test('PV irraggiungibile corretto con coordinate: riepilogo completo', async () => {
    p.tab('pv'); p.set('pvCerca', '14'); $('pvCerca').dispatchEvent(new w.Event('change'));
    await p.finche(() => p.libero() && /^14/.test(d.querySelector('#confronto h2').textContent), 'PV 14');
    p.set('pvCoord', '44.0600, 12.5600'); $('btnSalvaPV').click(); await p.attendiMsg(/14 salvato/);
    p.tab('riep');
    await p.finche(() => !/Mancano/.test($('riepilogo').textContent), 'riepilogo completo');
  });

  await t.test('punto di ottimo: calcolato, distanze, costa meno di tutte le sedi', async () => {
    p.tab('conf'); $('btnOttimo').click();
    await p.attendiMsg(/Punto di ottimo calcolato su 308 punti vendita/);
    assert.strictEqual(S.db.sedi[4].geocodifica, 'calcolato');
    assert.strictEqual(S.db.distanze.filter(x => x.sede === 'OTTIMO').length, 308);
    p.tab('riep');
    const righe = [...d.querySelectorAll('#riepilogo tbody tr')];
    assert.strictEqual(righe.length, 5);
    const sopra = righe.slice(0, 4).map(r => Number(r.cells[7].textContent.replace(/[^\d,-]/g, '').replace(',', '.')));
    sopra.forEach(v => assert.ok(v >= 0, 'una sede costa meno dell\'ottimo: ' + v));
  });

  await t.test('ricarica dati: paginazione oltre 1000 righe, stessi totali', async () => {
    const prima = $('riepilogo').innerHTML;
    assert.ok(S.db.distanze.length > 1000);
    $('btnRicarica').click(); await p.attendiMsg(/Dati aggiornati/);
    assert.strictEqual(w.__simulatore.stato.dist.length, S.db.distanze.length);
    assert.strictEqual($('riepilogo').innerHTML, prima);
    assert.ok(S.stats.maxRange <= 1000);
  });

  await t.test('estrazione Excel: 3 fogli, righe e numeri corretti', async () => {
    $('btnXlsx').click(); await p.attendiMsg(/File Excel generato/);
    const f = w.__scaricati.at(-1);
    assert.match(f.nome, /^simulazione_cedi_\d{4}-\d{2}-\d{2}\.xlsx$/);
    const ab = await p.leggiBlob(f.blob, 'readAsArrayBuffer');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(ab));
    assert.deepStrictEqual(wb.worksheets.map(x => x.name), ['Riepilogo', 'Dettaglio', 'Parametri']);
    assert.strictEqual(wb.getWorksheet('Riepilogo').rowCount, 6);
    assert.strictEqual(wb.getWorksheet('Dettaglio').rowCount, 1 + 308 * 5);
    const st = w.__simulatore.stato;
    const e = C.estrazione(st.P, st.sedi, C.tabella(st.P, st.sedi, st.pv, st.dist));
    assert.strictEqual(wb.getWorksheet('Riepilogo').getRow(2).getCell(5).value, e.riepilogo[0][4]);
    assert.strictEqual(typeof wb.getWorksheet('Dettaglio').getRow(2).getCell(9).value, 'number');
  });

  await t.test('estrazione CSV', async () => {
    $('btnCsv').click(); await p.attendiMsg(/CSV generato/);
    const testo = await p.leggiBlob(w.__scaricati.at(-1).blob, 'readAsText');
    const linee = testo.replace(/^﻿/, '').split('\r\n');
    assert.ok(linee[0].startsWith('Sede;Indirizzo;'));
    assert.strictEqual(linee.length, 1 + 5 + 1 + 1 + 308 * 5);
  });

  await t.test('elimina PV: cascata sulle distanze', async () => {
    p.tab('pv'); p.set('pvCerca', '003'); $('pvCerca').dispatchEvent(new w.Event('change'));
    await p.finche(() => p.libero() && /^003/.test(d.querySelector('#confronto h2').textContent), 'PV 003');
    $('btnEliminaPV').click(); await p.attendiMsg(/003 eliminato/);
    assert.ok(!S.db.punti_vendita.some(x => x.codice === '003'));
    assert.ok(!S.db.distanze.some(x => x.pv === '003'));
  });

  await t.test('spostare una sede invalida solo le sue distanze', async () => {
    p.tab('conf');
    const altre = S.db.distanze.filter(x => x.sede !== 'OPZ2').length;
    await salvaSede(2, 'S. Lazzaro', 'Via San Lazzaro 1, San Lazzaro di Savena');
    assert.match(p.$('msg').textContent, /Aggiorna distanze/);
    assert.strictEqual(S.db.distanze.filter(x => x.sede === 'OPZ2').length, 0);
    assert.strictEqual(S.db.distanze.length, altre);
  });

  await t.test('esci', async () => {
    $('btnEsci').click();
    await p.finche(() => !$('tab-login').hidden && $('nav').hidden, 'logout');
  });

  await t.test('nessun errore JavaScript nella pagina', () => { assert.deepStrictEqual(p.errori, []); });
});

test('limite ORS raggiunto: l\'app aspetta e riprova da sola', async () => {
  const p = apriPagina({ orsOpz: { limiteUnaVolta: true }, sessione: { user: { email: 'alice@esempio.it' } } });
  await p.finche(() => !p.$('tab-pv').hidden && p.libero() && p.$('pEuroKm').value, 'avvio con sessione');
  p.tab('conf');
  const row = p.d.querySelectorAll('#sediForm .sede')[0];
  row.querySelector('.sInd').value = 'Via Emilia 1, Bologna'; row.querySelector('.sSalva').click();
  await p.attendiMsg(/salvata/);
  assert.strictEqual(p.ors.st.geocode, 1);
  assert.deepStrictEqual(p.errori, []);
});

test('sessione scaduta o funzione non pubblicata: errore leggibile', async () => {
  const supa = creaSupabaseFinto(caricaFunzioneOrs(creaOrsFinto().fetch), { sessione: { user: { email: 'a@b.it' } } });
  supa.client.functions.invoke = async () => ({ data: null, error: { message: 'Function not found' } });
  const p = apriPagina({ supa });
  await p.finche(() => p.libero() && p.$('pEuroKm').value, 'avvio');
  p.tab('conf');
  const row = p.d.querySelectorAll('#sediForm .sede')[0];
  row.querySelector('.sInd').value = 'Via Emilia 1, Bologna'; row.querySelector('.sSalva').click();
  await p.attendiMsg(/Servizio distanze non raggiungibile \(funzione "ors" pubblicata\?\)/);
});
