/* Lettura dei file Excel in un thread separato (i file del gestionale possono superare i 15 MB):
   restituisce alla pagina solo il risultato già preparato, non l'intero foglio. */
importScripts('vendor/xlsx-0.18.5.full.min.js', 'calcolo.js?v=4');
self.onmessage = function (e) {
  try {
    var righe = self.Calcolo.righeDaExcel(self.XLSX, new Uint8Array(e.data.buffer));
    var risultato = e.data.tipo === 'tariffe' ? self.Calcolo.preparaTariffe(righe) : self.Calcolo.preparaImport(righe);
    self.postMessage({ ok: true, risultato: risultato });
  } catch (err) {
    self.postMessage({ ok: false, errore: err && err.message ? err.message : String(err) });
  }
};
