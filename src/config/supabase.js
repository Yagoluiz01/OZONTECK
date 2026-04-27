import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

export const supabase = createClient(
  env.supabaseUrl,
  env.supabaseAnonKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);


export const supabaseAdmin = createClient(
  env.supabaseUrl,
  env.supabaseServiceRoleKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

export const supabaseAuth = supabase;
export default supabase;