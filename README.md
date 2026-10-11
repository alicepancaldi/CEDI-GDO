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

## Volumi: due modi
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
