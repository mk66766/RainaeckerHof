-- Eingespielt am 20.10.2026 als Migration admin_only_payment_confirm.
-- Eingang bestätigen (pay_state = 'bestaetigt', confirmed_at/confirmed_by) darf nur der Admin: nur er hat Zugriff auf das PayPal-Konto.
create or replace function app.guard_payment_confirm() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or app.is_admin() then return new; end if;   -- Service-Rolle/SQL und Admin dürfen alles
  if tg_op = 'INSERT' then
    if new.pay_state = 'bestaetigt' or new.confirmed_by is not null or new.confirmed_at is not null then
      raise exception 'Den Zahlungseingang bestätigt nur der Admin.' using errcode = '42501';
    end if;
  elsif (new.pay_state is distinct from old.pay_state and (new.pay_state = 'bestaetigt' or old.pay_state = 'bestaetigt'))
     or new.confirmed_by is distinct from old.confirmed_by or new.confirmed_at is distinct from old.confirmed_at then
    raise exception 'Den Zahlungseingang bestätigt nur der Admin.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function app.guard_payment_confirm() from public, anon, authenticated;

create trigger guard_payment_confirm before insert or update on public.transactions
  for each row execute function app.guard_payment_confirm();
