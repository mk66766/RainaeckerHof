-- Eingespielt am 20.10.2026 als Migration family_codes_for_admin.
-- Zugangscodes der Familien für den Admin aufheben (auf Wunsch des Nutzers, damit der Admin Einladungen erneut verschicken kann).
-- Schreiben nur über die Edge Function manage-family (Service-Rolle), lesen nur Admins. Kein Änderungsprotokoll auf dieser Tabelle.
create table public.family_codes (
  family_id uuid primary key references public.families(id) on delete cascade,
  code text not null check (code ~ '^\d{6}$'),
  set_at timestamptz not null default now()
);
alter table public.family_codes enable row level security;
revoke all on public.family_codes from anon, authenticated;
grant select on public.family_codes to authenticated;
create policy "Admin liest Codes" on public.family_codes for select to authenticated using (app.is_admin());
