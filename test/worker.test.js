// Il lettore in thread separato (js/lettore-worker.js) eseguito con importScripts simulato
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ExcelJS = require('exceljs');

function avviaWorker() {
  const dir = path.join(__dirname, '..', 'js');
  const messaggi = [];
  const ctx = { console, Uint8Array, ArrayBuffer, Date, Math, JSON, Array, Object, String, Number, Error, RegExp, isNaN, isFinite, parseInt, parseFloat, TextDecoder, setTimeout };
  ctx.self = ctx;
  ctx.postMessage = m => messaggi.push(JSON.parse(JSON.stringify(m)));
  ctx.importScripts = (...files) => files.forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f.replace(/\?.*$/, '')), 'utf8'), ctx, { filename: f }));
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(dir, 'lettore-worker.js'), 'utf8'), ctx, { filename: 'lettore-worker.js' });
  return { invia: dati => ctx.onmessage({ data: dati }), messaggi };
}

test('worker: legge un file del gestionale e restituisce solo i viaggi preparati', async () => {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('x');
  ws.addRow(['numvg', 'dtv', 'codcli', 'numito', 'Telefono', 'rs', 'ind_bc', 'città_bc', 'prov_bc']);
  ws.addRow([1, new Date(Date.UTC(2026, 7, 3)), 80815, 2, '3331234567', 'MEGA', 'Via A 1', 'BARI', 'BA']);
  const buf = await wb.xlsx.writeBuffer();
  const w = avviaWorker();
  w.invia({ buffer: new Uint8Array(buf).buffer, tipo: '' });
  assert.strictEqual(w.messaggi.length, 1);
  const m = w.messaggi[0];
  assert.strictEqual(m.ok, true);
  assert.strictEqual(m.risultato.tipo, 'viaggi');
  assert.strictEqual(m.risultato.viaggi[0].data, '2026-08-03');
  assert.ok(!JSON.stringify(m).includes('3331234567'));
});

test('worker: tariffario ed errori', async () => {
  const wb = new ExcelJS.Workbook(); wb.addWorksheet('t').addRow(['km da', 'km a', '€/km']); wb.getWorksheet('t').addRow([0, 100, 1.5]);
  const w = avviaWorker();
  w.invia({ buffer: new Uint8Array(await wb.xlsx.writeBuffer()).buffer, tipo: 'tariffe' });
  assert.deepStrictEqual(w.messaggi[0].risultato, [{ anno: null, mezzo: '*', km_da: 0, km_a: 100, euro_km: 1.5, euro_fisso: 0 }]);
  w.invia({ buffer: new Uint8Array([1, 2, 3]).buffer, tipo: '' });
  assert.strictEqual(w.messaggi[1].ok, false);
});
