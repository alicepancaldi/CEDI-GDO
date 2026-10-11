# Simulatore rilocalizzazione CEDI

Pagina web per confrontare il costo di trasporto CEDI → punti vendita tra:
- il CEDI attuale;
- tre localizzazioni alternative;
- il punto di ottimo teorico.

Le distanze sono stradali reali per mezzi pesanti (OpenRouteService, profilo `driving-hgv`). I dati sono condivisi tra tutti gli utenti (Supabase).

## Struttura
| Percorso | Contenuto |
|---|---|
| `index.html`, `css/`, `js/` | La pagina (pubblicata con GitHub Pages) |
| `js/calcolo.js` | Modello di costo e punto di ottimo (funzioni pure) |
| `js/config.js` | URL e chiave pubblica del progetto Supabase |
| `js/vendor/` | Librerie incluse: supabase-js 2.117.3, ExcelJS 4.4.0 (licenza MIT) |
| `supabase/schema.sql` | Tabelle e regole di accesso |
| `supabase/functions/ors/index.ts` | Funzione server che chiama OpenRouteService; la chiave ORS resta sul server |
| `test/` | Test automatici (`npm install && npm test`) |

## Installazione

### 1. Supabase (database e login)
1. Su [supabase.com](https://supabase.com) creare un progetto (piano Free, regione Europa).
2. **SQL Editor → New query**: incollare `supabase/schema.sql` ed eseguire con **Run**. Lo script si può rieseguire senza perdere dati.
3. **Authentication → Sign In / Providers**: disattivare "Allow new users to sign up". Così si entra solo con gli accessi creati dall'amministratore.
4. **Authentication → Users → Add user**: creare ogni utente con email e password, spuntando "Auto Confirm User".

### 2. Funzione per le distanze
1. Su [openrouteservice.org](https://openrouteservice.org) creare un account e, dalla Dashboard, un token (piano Standard gratuito).
2. In Supabase, **Edge Functions → Secrets**: aggiungere il secret `ORS_API_KEY` con il token come valore.
3. **Edge Functions → Deploy a new function → Via Editor**:
   - nome della funzione: `ors`;
   - incollare il contenuto di `supabase/functions/ors/index.ts` e premere **Deploy**;
   - in **Settings** della funzione disattivare "Verify JWT with legacy secret": il controllo del login è fatto dalla funzione stessa, compatibile con le chiavi JWT nuove.

### 3. Pagina
1. In `js/config.js` inserire `SUPABASE_URL` e `SUPABASE_ANON_KEY`, presi da Project Settings → API. La chiave "anon" è pubblica per natura: i dati sono protetti dal login e dalle regole in `schema.sql`.
2. Su GitHub, in **Settings → Pages**, impostare Source "Deploy from a branch", branch `main`, cartella `/ (root)`.
3. La pagina è disponibile su `https://<utente>.github.io/<repository>/`.

## Uso
1. **Configurazione e import**
   - Parametri del vettore: €/km, km fatturati (andata e ritorno o solo andata), pallet per mezzo, eventuale costo fisso per viaggio, settimane operative.
   - Sedi: CEDI attuale e 3 opzioni. Le coordinate sono facoltative e servono a correggere un indirizzo trovato male.
   - Import dei punti vendita da Excel (.xlsx) o CSV. Le intestazioni sono riconosciute anche se scritte in modo diverso: "Cod. PV", "Insegna", "Via", "CAP", "Città", "Prov", "Pallet settimana", ecc.
   - **Calcola punto di ottimo**.
2. **Confronto punto vendita**: si inserisce o si cerca un PV e la maschera mostra per ogni sede:
   - km e tempo di guida;
   - viaggi a settimana;
   - costo per viaggio, a settimana e all'anno;
   - scostamenti rispetto al CEDI attuale.
3. **Riepilogo ed estrazione**
   - Totali per sede, delta rispetto all'attuale e distanza in €/anno dal punto di ottimo.
   - Elenco delle posizioni da verificare e delle distanze non trovate.
   - Estrazione in Excel (fogli Riepilogo, Dettaglio e Parametri) o in CSV.

## Metodo consigliato: ricalcolo dei viaggi reali
Si importa l'estrazione mensile del gestionale di magazzino (un file per mese). Ogni viaggio reale (stessi clienti, stesso mezzo, stessi carichi) viene ricalcolato da ogni sede:
- km del viaggio = distanza stradale per mezzi pesanti dalla sede al **cliente più lontano del giro**, × 2 se i km fatturati sono andata e ritorno;
- costo del viaggio = **tariffario del vettore** dell'anno in uso (fasce di km con €/km e/o importo fisso, eventualmente per tipo di mezzo); senza tariffario si usa la tariffa €/km dei parametri;
- costo annuo = costo del periodo × 365 / giorni del periodo;
- il costo di ogni viaggio è ripartito tra i clienti in proporzione al carico (maschera del punto vendita).

Dal file del gestionale vengono acquisiti solo viaggio, data, giro, vettore (ragione sociale), tipo di mezzo, capacità, clienti e carichi: nessun dato di autisti, targhe o telefoni. I file grandi (15 MB e oltre) sono letti in un thread separato del browser.

Il punto di ottimo, con i viaggi importati, è il punto che minimizza la somma dei costi dei viaggi reali (distanze in linea d'aria × fattore di tortuosità stimato dalle distanze stradali già calcolate, ricerca a griglia con raffinamento); poi viene valorizzato con le distanze stradali come le altre sedi.

## Adeguamento gasolio e CO₂

Allegato E: il 30% della tariffa segue il prezzo medio mensile del gasolio (netto IVA e accise rimborsate, tabelle MIT/MASE) rispetto al riferimento di agosto 2023, 1,289 €/l.

- Per i viaggi del mese *m* si usa il prezzo medio del mese *m* (il "mese trascorso", calcolato a fine mese).
- Variazione v = (prezzo − 1,289) / 1,289. Dalla variazione si **sottrae** la franchigia del 5%: adeguamento = 30% × segno(v) × (|v| − 5%), zero entro la franchigia. Regola verificata sui riconoscimenti ai vettori di maggio–agosto 2026 (scarto −0,6% sul totale).
- Adeguamento di una sede = Σ costo del viaggio × adeguamento del suo mese; costo con adeguamento = costo base + adeguamento.
- Litri = km percorsi (andata e ritorno fino al cliente più lontano) × consumo (motrice 0,28 l/km, bilico 0,33 l/km, modificabili); CO₂ = litri × 2,65 kg/l (modificabile).

In Configurazione → "Adeguamento gasolio e CO₂" si inseriscono i parametri e un prezzo per ogni mese che serve ai viaggi importati. In alternativa si carica la tabella MIT (Anno, Mese, Prezzo, IVA, Accisa in €/1000 l): il prezzo usato è prezzo − IVA − rimborso accise all'autotrasporto (accisa − 403,22 €/1000 l), coerente con il riferimento di 1,289 €/l. Richiede la parte "Versione 4" di `supabase/schema.sql`.

## Volumi senza viaggi reali: due modi
- **Carichi giornalieri** (consigliato), cioè i colli per cliente, giorno e reparto, dal file di logistica. Il carico di un giorno è la somma dei reparti, convertiti in pallet con i fattori "colli per pallet" di ogni reparto (Configurazione). I viaggi si calcolano **giorno per giorno**: carico del giorno ÷ capacità del mezzo, arrotondato per eccesso. Poi si riportano a settimana: viaggi del periodo ÷ (giorni con dati ÷ giorni lavorativi a settimana).
- **Pallet e consegne a settimana** inseriti a mano, per i PV senza carichi giornalieri.

## Modello di calcolo
- viaggi per consegna = arrotondamento per eccesso di (pallet per consegna / capacità mezzo)
- viaggi a settimana = consegne a settimana × viaggi per consegna
- costo viaggio = km × (2 se andata e ritorno, 1 se solo andata) × €/km + costo fisso per viaggio
- costo anno = viaggi a settimana × costo viaggio × settimane operative

**Punto di ottimo.** È il punto che minimizza la somma dei costi di trasporto: mediana geometrica pesata, cioè il problema di Weber. Si calcola con l'algoritmo di Weiszfeld e la correzione di Vardi-Zhang.
- Il peso di ogni PV è viaggi a settimana × km fatturati per km × €/km.
- Il calcolo usa le distanze geografiche; il risultato viene poi valorizzato con le distanze stradali reali, come le altre sedi.
- È un riferimento teorico: può cadere in un punto non edificabile.

## Note operative
- Le mappe della scheda Dashboard usano la cartina OpenStreetMap (sfondo CARTO chiaro) con la libreria Leaflet 1.9.4, inclusa in js/vendor. Le mattonelle della cartina arrivano da internet; senza connessione si vede la mappa schematica.
- Le distanze vengono calcolate una volta sola e salvate. Si ricalcolano solo per le sedi o i PV spostati.
- La pagina rispetta i limiti al minuto di OpenRouteService e, se il limite viene raggiunto, aspetta e riprova da sola. Le quote giornaliere del piano gratuito si vedono nella dashboard ORS. Per centinaia di PV bastano poche decine di richieste, perché ogni richiesta copre fino a 45 tratte.
- Precisione delle posizioni:
  - "indirizzo esatto" e "via trovata" vanno bene;
  - "solo comune" va verificato: correggere l'indirizzo o inserire le coordinate.

## Test
```
npm install
npm test
```
I test usano un database Supabase simulato con le stesse regole dello schema e un server OpenRouteService simulato. La funzione `ors` provata è quella reale. Coprono:
- i calcoli verificati a mano;
- il punto di ottimo confrontato con una ricerca a griglia;
- l'import da Excel e CSV grezzi;
- la paginazione oltre 1000 righe;
- le estrazioni;
- gli errori di rete e i limiti ORS.
