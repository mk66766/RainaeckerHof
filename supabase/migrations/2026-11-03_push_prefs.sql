-- „Wer bekommt was?“ (03.11.2026): Der Admin schaltet je Familie einzelne Arten von Benachrichtigungen aus.
-- Standard ist „an“, gespeichert werden nur die Einträge, die der Admin ändert. Die Edge Function notify-order
-- liest die Tabelle mit dem Service-Schlüssel und lässt ausgeschaltete Arten weg. Hinweise und Nachrichten vom Admin
-- sowie der Test aus der App sind nicht betroffen.
-- Arten: order_new, order_ready, duty (Dienst und Wochenrückblick), cash, pay_check, month.
create table if not exists public.push_prefs (
  family_id  uuid not null references public.families(id) on delete cascade,
  kind       text not null check (kind in ('order_new', 'order_ready', 'duty', 'cash', 'pay_check', 'month')),
  enabled    boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (family_id, kind)
);
alter table public.push_prefs enable row level security;
create policy "Admin liest Benachrichtigungs-Schalter" on public.push_prefs for select to authenticated using (app.is_admin());
create policy "Admin legt Benachrichtigungs-Schalter an" on public.push_prefs for insert to authenticated with check (app.is_admin());
create policy "Admin ändert Benachrichtigungs-Schalter" on public.push_prefs for update to authenticated using (app.is_admin()) with check (app.is_admin());
create policy "Admin löscht Benachrichtigungs-Schalter" on public.push_prefs for delete to authenticated using (app.is_admin());
revoke all on public.push_prefs from anon;
