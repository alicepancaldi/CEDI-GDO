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
  w.eval(fs.readFileSync(path.join(RADICE, 'js/vendor/xlsx-0.18.5.full.min.js'), 'utf8'));
  w.supabase = { createClient: () => S.client };
  w.eval('window.CONFIG = ' + JSON.stringify(Object.assign({ PAUSA_MATRICE_MS: 0, PAUSA_GEOCODIFICA_MS: 0, PAUSA_LIMITE_MS: 10 }, config)) + ';');
  w.eval(leggi('js/calcolo.js'));
  w.eval(leggi('js/dashboard.js'));
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
    p.set('pvPallet', ''); $('btnSalvaPV').click(); await p.attendiMsg(/sia i pallet sia le consegne/);
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
  const p = apriPagina({ orsOpz: { limiteUnaVolta: true }, sessione: { user: { email: 'alice@esempio.it' }, access_token: 'jwt-valido' } });
  await p.finche(() => !p.$('tab-pv').hidden && p.libero() && p.$('pEuroKm').value, 'avvio con sessione');
  p.tab('conf');
  const row = p.d.querySelectorAll('#sediForm .sede')[0];
  row.querySelector('.sInd').value = 'Via Emilia 1, Bologna'; row.querySelector('.sSalva').click();
  await p.attendiMsg(/salvata/);
  assert.strictEqual(p.ors.st.geocode, 2, 'indirizzo + controllo del comune (dopo il 429 riprovato)');
  assert.deepStrictEqual(p.errori, []);
});

test('sessione scaduta o funzione non pubblicata: errore leggibile', async () => {
  const supa = creaSupabaseFinto(caricaFunzioneOrs(creaOrsFinto().fetch), { sessione: { user: { email: 'a@b.it' }, access_token: 'jwt-valido' } });
  supa.client.functions.invoke = async () => ({ data: null, error: { message: 'Function not found' } });
  const p = apriPagina({ supa });
  await p.finche(() => p.libero() && p.$('pEuroKm').value, 'avvio');
  p.tab('conf');
  const row = p.d.querySelectorAll('#sediForm .sede')[0];
  row.querySelector('.sInd').value = 'Via Emilia 1, Bologna'; row.querySelector('.sSalva').click();
  await p.attendiMsg(/Servizio distanze non raggiungibile \(funzione "ors" pubblicata\?\)/);
});

test('carichi giornalieri: import formato Megamark, fattori colli→pallet, viaggi giorno per giorno', async () => {
  const p = apriPagina({ sessione: { user: { email: 'alice@esempio.it' }, access_token: 'jwt-valido' } });
  const { $, d, w, S } = p;
  await p.finche(() => p.libero() && $('pEuroKm').value, 'avvio');
  p.tab('conf');
  const row = d.querySelectorAll('#sediForm .sede')[0];
  row.querySelector('.sInd').value = 'Via Emilia 1, Bologna'; row.querySelector('.sSalva').click();
  await p.attendiMsg(/salvata/);
  // un PV già esistente inserito a mano, che ora arriva anche nei carichi
  S.db.punti_vendita.push({ codice: '500', nome: 'vecchio', indirizzo: 'Via Modena 10, 41121 Modena (MO)', lat: 44.6471, lng: 10.9252, pallet_settimana: 10, consegne_settimana: 2, geocodifica: 'address' });
  $('btnRicarica').click(); await p.attendiMsg(/Dati aggiornati/);
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('LOGISTICA ');
  ws.addRow(['INTERPORTO BARI', 'LOGISTICA AGGIORNATA']);
  ws.addRow(['codcli', 'RAGIONE   SOCIALE', 'INDIRIZZO', 'CITTA', 'PROVINCIA_RIC', 'mag', 'LUN', new Date(Date.UTC(2026, 2, 3)), new Date(Date.UTC(2026, 2, 4))]);
  ws.addRow([500, 'MODENA SRL   ', 'Via Modena 10', 'Modena', 'MO', 'ortofrutta', 'X', 600, 800]);
  ws.addRow([500, 'MODENA SRL   ', 'Via Modena 10', 'Modena', 'MO', 'carne', 'X', 300, 300]);
  ws.addRow([501, 'CARPI SRL', 'Via Carpi 1, S.N.', 'Carpi', 'MO', 'ortofrutta', 'X', 330, 'X']);
  await p.caricaFile('LOGISTICA MEGA.xlsx', new Uint8Array(await wb.xlsx.writeBuffer()));
  await p.attendiMsg(/controllare l'anteprima/);
  assert.match($('anteprima').textContent, /Carichi giornalieri: 2 punti vendita \(1 nuovi\), 5 righe di carico, 2 giorni \(2026-03-03 – 2026-03-04\), reparti: carne, ortofrutta/);
  assert.match($('anteprima').textContent, /non numerica "X"/);
  // carichi vecchi da sostituire
  S.db.carichi.push({ pv: '500', data: '2025-01-01', reparto: 'vecchio', colli: 1 });
  $('btnConfermaImport').click();
  await p.attendiMsg(/Import completato/);
  assert.strictEqual(S.db.carichi.length, 5, 'carichi vecchi sostituiti');
  assert.deepStrictEqual(S.db.reparti.map(r => r.reparto).sort(), ['carne', 'ortofrutta']);
  assert.strictEqual(S.db.punti_vendita.find(x => x.codice === '501').indirizzo, 'Via Carpi 1, Carpi (MO)');
  assert.strictEqual(S.db.punti_vendita.find(x => x.codice === '500').pallet_settimana, 10, 'valori manuali conservati');
  assert.match($('repartiForm').textContent, /Mancano i fattori di conversione per: carne, ortofrutta/);
  // fattori: 30 colli per pallet -> PV 500: giorno 1 = 30 pallet (1 viaggio), giorno 2 = 36,67 (2 viaggi)
  d.querySelectorAll('#repartiForm .rFatt').forEach(i => { i.value = '30'; });
  d.getElementById('btnReparti').click();
  await p.attendiMsg(/Fattori di conversione salvati/);
  assert.deepStrictEqual(S.db.reparti.map(r => r.colli_per_pallet), [30, 30]);
  p.tab('riep'); $('btnDist').click();
  await p.attendiMsg(/Distanze aggiornate/);
  const st = w.__simulatore.stato;
  const pv500 = st.pv.find(x => x.codice === '500');
  const km = S.db.distanze.find(x => x.pv === '500').km;
  const m = C.metriche(pv500, st.sedi.ATTUALE, { km, minuti: 1 }, st.P);
  assert.strictEqual(Math.round(m.viaggiSett), 9, '3 viaggi in 2 giorni = 9 a settimana su 6 giorni');
  const righe = [...d.querySelectorAll('#riepilogo tbody tr')];
  assert.strictEqual(righe[0].cells[1].textContent, fmtIt(9 + 3)); // PV 501: 330 colli = 11 pallet in 1 giorno -> 1 viaggio -> 3/sett
  assert.match($('riepilogo').textContent, /Volumi dai carichi giornalieri: 2 giorni/);
  // pagina del PV: volumi dai carichi
  p.tab('pv'); p.set('pvCerca', '500'); $('pvCerca').dispatchEvent(new w.Event('change'));
  await p.finche(() => p.libero() && /dai carichi giornalieri/.test($('confronto').textContent), 'confronto 500');
  // svuotare pallet e consegne è consentito per un PV con carichi
  p.set('pvPallet', ''); p.set('pvConsegne', ''); $('btnSalvaPV').click();
  await p.attendiMsg(/500 salvato/);
  assert.strictEqual(S.db.punti_vendita.find(x => x.codice === '500').pallet_settimana, null);
  assert.deepStrictEqual(p.errori, []);
});

function fmtIt(n) { return Number(n).toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }

test('posizione fuori dal comune indicato: si usa il centro del comune; verifica posizioni corregge i PV già salvati', async () => {
  const p = apriPagina({ sessione: { user: { email: 'alice@esempio.it' }, access_token: 'jwt-valido' } });
  const { $, d, w, S } = p;
  await p.finche(() => p.libero() && $('pEuroKm').value, 'avvio');
  p.set('pvCodice', '647507'); p.set('pvIndirizzo', 'Via San Nicola 7, Torre a Mare (BA)'); p.set('pvPallet', '10'); p.set('pvConsegne', '6');
  $('btnSalvaPV').click(); await p.attendiMsg(/647507 salvato/);
  const pv = S.db.punti_vendita.find(x => x.codice === '647507');
  assert.deepStrictEqual([pv.lat, pv.lng, pv.geocodifica], [41.0866, 16.9967, 'fuori_comune']);
  assert.match($('msg').textContent, /usato il centro del comune/);
  // PV importato prima della correzione, con la posizione sbagliata
  S.db.punti_vendita.push({ codice: '999', nome: 'X', indirizzo: 'Via San Nicola 7, Torre a Mare (BA)', lat: 40.9044, lng: 8.872, pallet_settimana: 5, consegne_settimana: 3, geocodifica: 'address' });
  S.db.distanze.push({ sede: 'ATTUALE', pv: '999', km: 1000, minuti: 900, chiave: 'x' });
  $('btnRicarica').click(); await p.attendiMsg(/Dati aggiornati/);
  p.tab('riep'); $('btnVerificaPos').click();
  await p.attendiMsg(/posizioni aggiornate/);
  assert.match($('msg').textContent, /999 X/);
  const c = S.db.punti_vendita.find(x => x.codice === '999');
  assert.deepStrictEqual([c.lat, c.geocodifica], [41.0866, 'fuori_comune']);
  assert.ok(!S.db.distanze.some(x => x.pv === '999'), 'distanze vecchie eliminate');
  $('btnVerificaPos').click(); await p.attendiMsg(/Tutte le posizioni sono coerenti/);
  // comune cercato e trovato in un'altra provincia: posizione da correggere a mano, nessuna "correzione" sbagliata
  p.tab('pv'); $('btnNuovoPV').click();
  p.set('pvCodice', '76702'); p.set('pvIndirizzo', 'Via Napoli 3, Santo Spirito (BA)'); p.set('pvPallet', '10'); p.set('pvConsegne', '6');
  $('btnSalvaPV').click(); await p.attendiMsg(/76702 salvato/);
  assert.strictEqual(S.db.punti_vendita.find(x => x.codice === '76702').geocodifica, 'provincia_errata');
  assert.match($('msg').textContent, /altra provincia: inserire le coordinate/);
  // provincia vecchia nel dato ma comune giusto: posizione accettata
  $('btnNuovoPV').click();
  p.set('pvCodice', '177900'); p.set('pvIndirizzo', 'Via Quadrivio Nazionale 4, Cutro (CZ)'); p.set('pvPallet', '10'); p.set('pvConsegne', '6');
  $('btnSalvaPV').click(); await p.attendiMsg(/177900 salvato/);
  assert.strictEqual(S.db.punti_vendita.find(x => x.codice === '177900').geocodifica, 'address');
  assert.deepStrictEqual(p.errori, []);
});

test('viaggi reali: import dal gestionale, tariffario, riepilogo, PV, estrazione, ottimo; nessun dato personale salvato', async () => {
  const p = apriPagina({ sessione: { user: { email: 'alice@esempio.it' }, access_token: 'jwt-valido' } });
  const { $, d, w, S } = p;
  await p.finche(() => p.libero() && $('pEuroKm').value, 'avvio');
  p.tab('conf');
  for (const [i, ind] of [[0, 'Via Emilia 1, Bologna'], [1, 'Interporto, Bentivoglio']]) {
    const row = d.querySelectorAll('#sediForm .sede')[i];
    row.querySelector('.sInd').value = ind; row.querySelector('.sSalva').click();
    await p.attendiMsg(/salvata/);
  }
  // un PV già in anagrafica (non deve essere toccato), uno nuovo che arriva dai viaggi
  S.db.punti_vendita.push({ codice: '500', nome: 'ESISTENTE', indirizzo: 'Via Modena 10, Modena (MO)', lat: 44.6471, lng: 10.9252, pallet_settimana: null, consegne_settimana: null, geocodifica: 'address' });
  $('btnRicarica').click(); await p.attendiMsg(/Dati aggiornati/);
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('work (2)');
  ws.addRow(['mag', 'numvg', 'dtv', 'giro', 'codcli', 'numito', 'colli', 'nominativo', 'targa', 'pallet', 'roll', 'tipomezzo', 'rs', 'ind_bc', 'cap_bc', 'città_bc', 'prov_bc', 'Nome', 'Cognome', 'Telefono', 'km_GCL']);
  const riga = (vg, dt, cli, occ, nome, ind, cap, com, prov) => ws.addRow(['50', vg, dt, 'G1', cli, occ, 100, 'TRASPORTI 49', 'AB123CD', 12, 20, 'MOT12', nome, ind, cap, com, prov, 'MARIO', 'ROSSI', 3331234567, 40]);
  riga(9001, new Date(Date.UTC(2026, 7, 1)), 500, 3, 'ESISTENTE', 'Via Modena 10', '', 'Modena', 'MO');
  riga(9001, new Date(Date.UTC(2026, 7, 1)), 501, 1, 'CARPI SRL', 'Via Carpi 1', '', 'Carpi', 'MO');
  riga(9002, new Date(Date.UTC(2026, 7, 10)), 500, 6, 'ESISTENTE', 'Via Modena 10', '', 'Modena', 'MO');
  await p.caricaFile('Agosto 2026.xlsx', new Uint8Array(await wb.xlsx.writeBuffer()));
  await p.attendiMsg(/controllare l'anteprima/);
  assert.match($('anteprima').textContent, /Viaggi reali: 2 viaggi dal 2026-08-01 al 2026-08-10, 1,5 clienti per viaggio in media, saturazione media dei mezzi 42%\. Clienti nuovi da geolocalizzare: 1\./);
  assert.match($('anteprima').textContent, /cliente non presente in anagrafica: verrà aggiunto \(CARPI SRL/);
  $('btnConfermaImport').click();
  await p.attendiMsg(/Import completato/);
  assert.match($('anteprima').textContent, /2 viaggi salvati, 1 nuovi clienti/);
  assert.strictEqual(S.db.viaggi.length, 2); assert.strictEqual(S.db.viaggi_clienti.length, 3);
  assert.strictEqual(S.db.punti_vendita.find(x => x.codice === '500').nome, 'ESISTENTE');
  assert.strictEqual(S.db.punti_vendita.find(x => x.codice === '501').indirizzo, 'Via Carpi 1, Carpi (MO)');
  // PV arrivato dai viaggi: si salva dalla maschera senza pallet e consegne
  p.tab('pv'); p.set('pvCerca', '501'); $('pvCerca').dispatchEvent(new w.Event('change'));
  await p.finche(() => p.libero() && /^501/.test(d.querySelector('#confronto h2').textContent), 'PV 501');
  p.set('pvCoord', '44.7842, 10.8851'); $('btnSalvaPV').click(); await p.attendiMsg(/501 salvato/);
  assert.strictEqual(S.db.punti_vendita.find(x => x.codice === '501').pallet_settimana, null);
  p.tab('conf');
  const tuttoDb = JSON.stringify(S.db);
  ['MARIO', 'ROSSI', '3331234567', 'AB123CD'].forEach(x => assert.ok(!tuttoDb.includes(x), 'dato personale nel database: ' + x));
  // reimport dello stesso periodo: sostituisce, non duplica
  await p.caricaFile('Agosto 2026.xlsx', new Uint8Array(await wb.xlsx.writeBuffer()));
  await p.attendiMsg(/controllare l'anteprima/);
  assert.match($('anteprima').textContent, /I 2 viaggi già presenti nello stesso periodo verranno sostituiti/);
  $('btnConfermaImport').click(); await p.attendiMsg(/Import completato/);
  assert.strictEqual(S.db.viaggi.length, 2); assert.strictEqual(S.db.viaggi_clienti.length, 3);

  // tariffario 2026 da CSV, anno nel campo
  p.set('annoTariffe', '2026');
  const csv = 'km da;km a;€/km;€ fisso\r\n0;200;1,50;30\r\n200;;1,20;0\r\n';
  const fT = new w.File([csv], 'tariffario.csv', { type: 'text/csv' });
  Object.defineProperty($('fileTariffe'), 'files', { value: [fT], configurable: true });
  $('fileTariffe').dispatchEvent(new w.Event('change'));
  await p.attendiMsg(/Tariffario 2026 caricato: 2 righe/);
  assert.match($('tariffeInfo').textContent, /oltre/);
  // stesso anno ricaricato: sostituisce
  Object.defineProperty($('fileTariffe'), 'files', { value: [new w.File([csv], 't.csv')], configurable: true });
  $('fileTariffe').dispatchEvent(new w.Event('change'));
  await p.attendiMsg(/Tariffario 2026 caricato/);
  assert.strictEqual(S.db.tariffe.length, 2);

  p.tab('riep'); $('btnDist').click(); await p.attendiMsg(/Distanze aggiornate/);
  assert.match($('riepilogo').textContent, /Viaggi reali: 2 viaggi dal 2026-08-01 al 2026-08-10 \(10 giorni\), 2 clienti/);
  assert.match($('riepilogo').textContent, /Tariffario 2026/);
  const st = w.__simulatore.stato, dist = {}; st.dist.forEach(x => { dist[x.sede + x.pv] = x.km; });
  const kmV1 = 2 * Math.max(dist.ATTUALE500, dist.ATTUALE501), kmV2 = 2 * dist.ATTUALE500;
  const costo = km => km < 200 ? 30 + 1.5 * km : 1.2 * km;
  const atteso = (costo(kmV1) + costo(kmV2)) * 36.5;
  const cella = d.querySelectorAll('#riepilogo tbody tr')[0].cells[4].textContent;
  assert.strictEqual(cella, Math.round(atteso).toLocaleString('it-IT') + ' €');

  // maschera PV
  p.tab('pv'); p.set('pvCerca', '501'); $('pvCerca').dispatchEvent(new w.Event('change'));
  await p.finche(() => p.libero() && /servito da 1 viaggi reali/.test($('confronto').textContent), 'PV 501');
  const r501 = Object.fromEntries([...d.querySelectorAll('#confronto tbody tr')].map(tr => [tr.cells[0].textContent, [...tr.cells].slice(1).map(c => c.textContent)]));
  assert.strictEqual(r501['Costo ripartito nel periodo'][0], Math.round(costo(kmV1) * 0.25).toLocaleString('it-IT') + ' €');

  // gasolio: prezzo di agosto 2026 per i viaggi di agosto, oltre la franchigia (+10%)
  p.tab('conf');
  const inLuglio = d.querySelector('#gasolioMesi .gPrezzo[data-mese="2026-08"]');
  assert.ok(inLuglio, 'campo prezzo di agosto 2026');
  assert.strictEqual(d.querySelectorAll('#gasolioMesi .gPrezzo').length, 1);
  inLuglio.value = '1,418';
  $('btnGasolio').click(); await p.attendiMsg(/Gasolio salvato: 1 prezzi mensili/);
  assert.deepStrictEqual(S.db.gasolio, [{ mese: '2026-08', prezzo: 1.418 }]);
  assert.strictEqual(S.db.parametri[0].gas_quota, 0.3);
  p.tab('riep');
  assert.ok(!$('gasolio').hidden);
  const rgas = d.querySelectorAll('#gasolio table')[0].tBodies[0].rows;
  const adegAtteso = (costo(kmV1) + costo(kmV2)) * 0.3 * ((1.418 - 1.289) / 1.289 - 0.05) * 36.5;
  assert.strictEqual(rgas[0].cells[5].textContent, Math.round(adegAtteso).toLocaleString('it-IT') + ' €');
  const litriAttesi = (kmV1 + kmV2) * 0.28 * 36.5;
  assert.strictEqual(rgas[0].cells[1].textContent, Math.round(litriAttesi).toLocaleString('it-IT'));
  assert.doesNotMatch($('gasolio').textContent, /mancante/);
  // tabella MIT da file: prezzo contrattuale = prezzo − IVA − (accisa − 403,22)
  p.tab('conf');
  const csvG = 'Anno;Mese;Prezzo;IVA;Accisa;Netto\r\n2026;Agosto;2027,01;365,53;650;1011,49\r\n2026;Luglio;1953,53;352,28;612,9;988,35\r\n';
  Object.defineProperty($('fileGasolio'), 'files', { value: [new w.File([csvG], 'Gasolio_MIT.csv', { type: 'text/csv' })], configurable: true });
  $('fileGasolio').dispatchEvent(new w.Event('change'));
  await p.attendiMsg(/Prezzi del gasolio caricati: 2 mesi \(lug 2026 – ago 2026\)/);
  assert.strictEqual(S.db.gasolio.find(x => x.mese === '2026-08').prezzo, 1.4147);
  assert.strictEqual(S.db.gasolio.length, 2);
  // prezzo entro la franchigia: adeguamento zero
  p.tab('conf'); d.querySelector('#gasolioMesi .gPrezzo[data-mese="2026-08"]').value = '1,30';
  $('btnGasolio').click(); await p.attendiMsg(/Gasolio salvato/);
  p.tab('riep');
  assert.strictEqual(d.querySelectorAll('#gasolio table')[0].tBodies[0].rows[0].cells[5].textContent, '0 €');
  assert.match($('gasolio').textContent, /entro la franchigia/);

  // dashboard
  p.tab('dash');
  assert.strictEqual(d.querySelectorAll('#dashboard .tessera').length, 2);
  assert.match($('dashboard').textContent, /2 viaggi reali dal 2026-08-01 al 2026-08-10/);
  assert.ok(d.querySelectorAll('#dashboard svg').length >= 3);
  assert.match($('dashboard').textContent, /0 = Interporto/);
  p.tab('riep');

  // estrazione Excel con il foglio Viaggi
  p.tab('riep'); $('btnXlsx').click(); await p.attendiMsg(/File Excel generato/);
  const ab = await p.leggiBlob(w.__scaricati.at(-1).blob, 'readAsArrayBuffer');
  const out = new ExcelJS.Workbook(); await out.xlsx.load(Buffer.from(ab));
  assert.deepStrictEqual(out.worksheets.map(x => x.name), ['Riepilogo', 'Dettaglio PV', 'Viaggi', 'Gasolio e CO2', 'Gasolio mesi', 'Parametri']);
  assert.strictEqual(out.getWorksheet('Viaggi').rowCount, 3);
  assert.ok(!JSON.stringify(out.getWorksheet('Viaggi').getSheetValues()).includes('ROSSI'));

  // ottimo sui viaggi
  p.tab('conf'); $('btnOttimo').click();
  await p.attendiMsg(/Punto di ottimo calcolato sui 2 viaggi reali.*Affinato sulle distanze stradali reali/);
  p.tab('riep');
  const righe = [...d.querySelectorAll('#riepilogo tbody tr')];
  assert.strictEqual(righe.length, 3);
  const sopra = righe.slice(0, 2).map(r => Number(r.cells[8].textContent.replace(/[^\d,-]/g, '').replace(',', '.')));
  sopra.forEach(v => assert.ok(v >= -1, 'sede che costa meno dell\'ottimo: ' + v));
  assert.deepStrictEqual(p.errori, []);
});

test('database senza la tabella gasolio (migrazione 4 non ancora eseguita): l\'app si apre e lo segnala', async () => {
  const supa = creaSupabaseFinto(caricaFunzioneOrs(creaOrsFinto().fetch), { sessione: { user: { email: 'a@b.it' }, access_token: 'jwt-valido' } });
  const orig = supa.client.from.bind(supa.client);
  supa.client.from = t => {
    if (t !== 'gasolio') return orig(t);
    const q = { select: () => q, order: () => q, range: () => Promise.resolve({ data: null, error: { message: 'relation "public.gasolio" does not exist' } }) };
    return q;
  };
  const p = apriPagina({ supa });
  await p.finche(() => !p.$('tab-pv').hidden && p.libero() && p.$('pEuroKm').value === '1,30', 'dati caricati');
  p.tab('conf');
  assert.match(p.$('gasolioMesi').textContent, /Versione 4/);
  assert.strictEqual(p.$('gRif').value, '1,289');
  p.$('btnGasolio').click(); await p.attendiMsg(/Versione 4/);
  assert.deepStrictEqual(p.errori, []);
});

test('perimetro: PV in Campania già nel database esclusi da calcoli, viaggi e maschera', async () => {
  const supa = creaSupabaseFinto(caricaFunzioneOrs(creaOrsFinto().fetch), { sessione: { user: { email: 'a@b.it' }, access_token: 'jwt-valido' } });
  const pv = (codice, indirizzo, lat, lng) => ({ codice, nome: 'PV ' + codice, indirizzo, lat, lng, pallet_settimana: null, consegne_settimana: null, geocodifica: 'address' });
  supa.db.punti_vendita.push(pv('100', 'Via Emilia 1, 40100 Bologna (BO)', 44.4949, 11.3426), pv('36051', "Via Consortile, 81030 Gricignano d'Aversa (CE)", 40.98, 14.23));
  supa.db.viaggi.push({ id: 'V1', data: '2026-07-01', giro: '', vettore: '', mezzo: 'MOT23' }, { id: 'V2', data: '2026-07-02', giro: '', vettore: '', mezzo: 'MOT23' });
  supa.db.viaggi_clienti.push({ viaggio: 'V1', pv: '100', occ: 1, colli: 10, km_zona: null }, { viaggio: 'V1', pv: '36051', occ: 1, colli: 10, km_zona: null }, { viaggio: 'V2', pv: '36051', occ: 5, colli: 50, km_zona: null });
  Object.assign(supa.db.sedi[0], { indirizzo: 'Interporto, Bentivoglio', lat: 44.637, lng: 11.407, geocodifica: 'manuale' });
  const p = apriPagina({ supa });
  await p.finche(() => !p.$('tab-pv').hidden && p.libero() && p.$('pEuroKm').value === '1,30', 'dati caricati');
  const st = p.w.__simulatore.stato;
  assert.strictEqual(JSON.stringify(st.pv.map(x => x.codice)), '["100"]');
  assert.strictEqual(JSON.stringify(st.viaggi.map(v => [v.id, v.clienti.map(c => c.pv)])), '[["V1",["100"]]]');
  assert.strictEqual(st.viaggiFuori, 1);
  p.tab('riep');
  assert.match(p.$('riepilogo').textContent, /Fuori perimetro \(Campania\): 1 punti vendita esclusi da calcoli ed estrazioni, 1 viaggi/);
  p.tab('pv'); p.set('pvCodice', '999'); p.set('pvIndirizzo', 'Via Roma 1, 80100 Napoli (NA)');
  p.$('btnSalvaPV').click(); await p.attendiMsg(/fuori dal perimetro/);
  assert.ok(!supa.db.punti_vendita.some(x => x.codice === '999'));
  assert.deepStrictEqual(p.errori, []);
});

test('dashboard: più mesi, prezzo mancante, mappa', () => {
  const dom = new JSDOM('<div id="d"></div>', { runScripts: 'outside-only' });
  dom.window.eval(leggi('js/dashboard.js'));
  const sede = (c, n, costo, dc, co2, dco2) => ({ codice: c, nome: n, costoAnno: costo, deltaAnno: dc, deltaPct: dc == null ? null : dc / 6e6 * 100, co2Anno: co2, deltaCo2: dco2, deltaCo2Pct: dco2 == null ? null : dco2 / 3500 * 100, adeguamentoAnno: 280000 });
  const ms = (m, adeg, mancante) => ({ mese: m, prezzo: mancante ? null : 1.5, variazione: mancante ? null : 0.16, adeguamento: adeg, mancante, viaggi: 2000,
    sedi: { ATTUALE: { costoTot: 500000, adeguamento: 500000 * adeg }, OPZ1: { costoTot: 494000, adeguamento: 1 }, OPZ2: { costoTot: 555000, adeguamento: 1 }, OTTIMO: { costoTot: 495000, adeguamento: 1 } } });
  const D = { periodo: { dal: '2026-05-02', al: '2026-08-31', giorni: 122, viaggi: 8772, clienti: 338 },
    sedi: [sede('ATTUALE', 'Interporto', 6.3e6, null, 3497, null), sede('OPZ1', 'Cellamare', 6.24e6, -67788, 3454, -43), sede('OPZ2', 'Molfetta', 6.98e6, 669306, 3867, 370), sede('OTTIMO', 'Punto di ottimo', 6.25e6, -55105, 3463, -35)],
    mesi: [ms('2026-05', 0.0449), ms('2026-06', 0.0089), ms('2026-07', 0, true)], franchigia: 0.05, mesiMancanti: ['2026-07'], nota: '',
    punti: [{ codice: '1', nome: 'A', lat: 41.1, lng: 16.8, viaggi: 50 }, { codice: '2', nome: 'B', lat: 40.4, lng: 17.9, viaggi: 10 }],
    sediPos: [{ codice: 'ATTUALE', nome: 'Interporto', lat: 41.08, lng: 16.84 }, { codice: 'OPZ1', nome: 'Cellamare', lat: 41.02, lng: 16.92 }, { codice: 'OPZ2', nome: 'Molfetta', lat: 41.2, lng: 16.6 }] };
  const el = dom.window.document.getElementById('d');
  dom.window.Dashboard.disegna(el, D);
  assert.strictEqual(el.querySelectorAll('.tessera').length, 4);
  assert.strictEqual(el.querySelectorAll('svg').length, 7);
  assert.match(el.textContent, /Prezzo del gasolio mancante per: lug 26/);
  assert.match(el.textContent, /−1,2%/);
  assert.ok(!/NaN|undefined/.test(el.innerHTML));
  dom.window.Dashboard.disegna(el, null);
  assert.match(el.textContent, /Importare i viaggi reali/);
});
