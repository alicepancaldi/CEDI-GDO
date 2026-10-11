-- Simulatore rilocalizzazione CEDI — schema dati Supabase
-- Da incollare in Supabase: SQL Editor > New query > Run. Si può rieseguire senza perdere dati.

create table if not exists public.parametri (
  id                  int primary key default 1 check (id = 1),
  euro_km             numeric not null default 1.30 check (euro_km > 0),
  km_fatturati        text    not null default 'AR' check (km_fatturati in ('AR', 'A')),
  capacita_pallet     numeric not null default 33   check (capacita_pallet > 0),
  costo_fisso_viaggio numeric not null default 0    check (costo_fisso_viaggio >= 0),
  settimane_anno      numeric not null default 52   check (settimane_anno > 0 and settimane_anno <= 53),
  aggiornato_il       timestamptz not null default now()
);
insert into public.parametri (id) values (1) on conflict (id) do nothing;

create table if not exists public.sedi (
  codice         text primary key check (codice in ('ATTUALE', 'OPZ1', 'OPZ2', 'OPZ3', 'OTTIMO')),
  nome           text not null,
  indirizzo      text not null default '',
  lat            double precision,
  lng            double precision,
  capacita_mezzo numeric check (capacita_mezzo is null or capacita_mezzo > 0),
  geocodifica    text not null default '',  -- precisione della posizione: address, street, locality..., manuale, calcolato
  aggiornato_il  timestamptz not null default now()
);
insert into public.sedi (codice, nome) values
  ('ATTUALE', 'CEDI attuale'), ('OPZ1', 'Opzione 1'), ('OPZ2', 'Opzione 2'),
  ('OPZ3', 'Opzione 3'), ('OTTIMO', 'Punto di ottimo')
on conflict (codice) do nothing;

create table if not exists public.punti_vendita (
  codice             text primary key check (length(trim(codice)) > 0),
  nome               text not null default '',
  indirizzo          text not null,
  lat                double precision not null,
  lng                double precision not null,
  pallet_settimana   numeric not null check (pallet_settimana > 0),
  consegne_settimana numeric not null check (consegne_settimana > 0),
  geocodifica        text not null default '',  -- precisione della posizione: address, street, locality..., manuale
  aggiornato_il      timestamptz not null default now()
);

-- Colonne aggiunte dopo la prima versione (sicuro rieseguire)
alter table public.sedi          add column if not exists geocodifica text not null default '';
alter table public.punti_vendita add column if not exists geocodifica text not null default '';

-- Distanze stradali calcolate (cache). "chiave" = coordinate sede+PV: se cambiano, la distanza va ricalcolata.
create table if not exists public.distanze (
  sede          text not null references public.sedi(codice) on delete cascade,
  pv            text not null references public.punti_vendita(codice) on delete cascade on update cascade,
  km            double precision not null check (km >= 0),
  minuti        double precision not null check (minuti >= 0),
  chiave        text not null,
  aggiornato_il timestamptz not null default now(),
  primary key (sede, pv)
);

-- Accesso: solo utenti con login (creati dall'amministratore in Authentication > Users)
alter table public.parametri     enable row level security;
alter table public.sedi          enable row level security;
alter table public.punti_vendita enable row level security;
alter table public.distanze      enable row level security;

drop policy if exists "utenti autenticati" on public.parametri;
drop policy if exists "utenti autenticati" on public.sedi;
drop policy if exists "utenti autenticati" on public.punti_vendita;
drop policy if exists "utenti autenticati" on public.distanze;
create policy "utenti autenticati" on public.parametri     for all to authenticated using (true) with check (true);
create policy "utenti autenticati" on public.sedi          for all to authenticated using (true) with check (true);
create policy "utenti autenticati" on public.punti_vendita for all to authenticated using (true) with check (true);
create policy "utenti autenticati" on public.distanze      for all to authenticated using (true) with check (true);

-- Le sedi non si cancellano né si creano dall'app: solo modifica
revoke insert, delete on public.sedi from authenticated;
revoke delete, insert on public.parametri from authenticated;

-- ============ Versione 2: carichi giornalieri in colli e conversione colli → pallet ============
-- I volumi possono arrivare come carichi giornalieri per reparto (colli); in quel caso
-- pallet_settimana e consegne_settimana del PV non servono e restano vuoti.
alter table public.punti_vendita alter column pallet_settimana drop not null;
alter table public.punti_vendita alter column consegne_settimana drop not null;
alter table public.parametri add column if not exists giorni_settimana numeric not null default 6 check (giorni_settimana >= 1 and giorni_settimana <= 7);

create table if not exists public.reparti (
  reparto          text primary key,
  colli_per_pallet numeric check (colli_per_pallet is null or colli_per_pallet > 0),
  aggiornato_il    timestamptz not null default now()
);

create table if not exists public.carichi (
  pv      text not null references public.punti_vendita(codice) on delete cascade on update cascade,
  data    date not null,
  reparto text not null,
  colli   numeric not null check (colli >= 0),
  primary key (pv, data, reparto)
);

alter table public.reparti enable row level security;
alter table public.carichi enable row level security;
drop policy if exists "utenti autenticati" on public.reparti;
drop policy if exists "utenti autenticati" on public.carichi;
create policy "utenti autenticati" on public.reparti for all to authenticated using (true) with check (true);
create policy "utenti autenticati" on public.carichi for all to authenticated using (true) with check (true);

-- ============ Versione 3: viaggi reali e tariffario annuale ============
-- Dai file del gestionale si acquisiscono solo: viaggio, data, giro, vettore (ragione sociale), tipo mezzo,
-- capacità, clienti serviti e carico. Nessun dato di autisti, targhe o telefoni.
create table if not exists public.viaggi (
  id         text primary key,
  data       date not null,
  giro       text not null default '',
  vettore    text not null default '',
  mezzo      text not null default '',
  cap_pallet numeric,
  cap_roll   numeric
);
create index if not exists viaggi_data on public.viaggi (data);

create table if not exists public.viaggi_clienti (
  viaggio text not null references public.viaggi(id) on delete cascade,
  pv      text not null references public.punti_vendita(codice) on delete cascade on update cascade,
  occ     numeric not null default 0,
  colli   numeric not null default 0,
  km_zona numeric,
  primary key (viaggio, pv)
);

create table if not exists public.tariffe (
  id         bigint generated always as identity primary key,
  anno       int not null,
  mezzo      text not null default '*',
  km_da      numeric not null default 0 check (km_da >= 0),
  km_a       numeric check (km_a is null or km_a > km_da),
  euro_km    numeric not null default 0 check (euro_km >= 0),
  euro_fisso numeric not null default 0 check (euro_fisso >= 0)
);
alter table public.parametri add column if not exists anno_tariffa int;

alter table public.viaggi enable row level security;
alter table public.viaggi_clienti enable row level security;
alter table public.tariffe enable row level security;
drop policy if exists "utenti autenticati" on public.viaggi;
drop policy if exists "utenti autenticati" on public.viaggi_clienti;
drop policy if exists "utenti autenticati" on public.tariffe;
create policy "utenti autenticati" on public.viaggi for all to authenticated using (true) with check (true);
create policy "utenti autenticati" on public.viaggi_clienti for all to authenticated using (true) with check (true);
create policy "utenti autenticati" on public.tariffe for all to authenticated using (true) with check (true);

-- ============ Versione 4: adeguamento gasolio (Allegato E) e CO2 ============
-- Prezzo medio mensile del gasolio (€/l al netto di IVA e accise rimborsate, tabelle MIT/MASE).
-- L'adeguamento dei viaggi di un mese usa il prezzo del mese precedente.
create table if not exists public.gasolio (
  mese   text primary key check (mese ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  prezzo numeric not null check (prezzo > 0)
);
alter table public.parametri add column if not exists gas_rif numeric not null default 1.289 check (gas_rif > 0);
alter table public.parametri add column if not exists gas_quota numeric not null default 0.30 check (gas_quota >= 0 and gas_quota <= 1);
alter table public.parametri add column if not exists gas_franchigia numeric not null default 0.05 check (gas_franchigia >= 0 and gas_franchigia < 1);
alter table public.parametri add column if not exists consumo_motrice numeric not null default 0.28 check (consumo_motrice > 0);
alter table public.parametri add column if not exists consumo_bilico numeric not null default 0.33 check (consumo_bilico > 0);
alter table public.parametri add column if not exists co2_kg_l numeric not null default 2.65 check (co2_kg_l > 0);

alter table public.gasolio enable row level security;
drop policy if exists "utenti autenticati" on public.gasolio;
create policy "utenti autenticati" on public.gasolio for all to authenticated using (true) with check (true);
