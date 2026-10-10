import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Isso aparece no console do navegador se esquecer de configurar o .env
  // (ou as variáveis de ambiente no Vercel). O app continua carregando, mas
  // nenhuma leitura/gravação de dados vai funcionar até configurar.
  console.warn(
    "[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY não configuradas. " +
      "Veja o README para o passo a passo."
  );
}

export const supabase = createClient(url, anonKey);
