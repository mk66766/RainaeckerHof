import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { makeFamilyHandler } from "./family.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
Deno.serve(makeFamilyHandler({ admin }));
