// src/lib/supabase.ts
import { createClient } from '@supabase/supabase-js';

const url = (import.meta as any).env.VITE_SUPABASE_URL || (import.meta as any).env.NEXT_PUBLIC_SUPABASE_URL;
const anon = (import.meta as any).env.VITE_SUPABASE_ANON_KEY || (import.meta as any).env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anon) {
  console.warn('[supabase] URL/ANON_KEY ausentes (defina VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY se for usar).');
}

export const supabase = createClient(url, anon);
