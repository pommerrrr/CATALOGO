// api/cron/refresh.js
// Cron stub: reconsulta preços quando SUPABASE estiver configurado.
// Sem configuração, apenas retorna ok:true para não quebrar o agendamento.
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const hasSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!hasSupabase) {
    return res.status(200).end(JSON.stringify({ ok: true, message: 'Cron ativo, mas SUPABASE não configurado. Sem ação.' }));
  }
  // Aqui você pode implementar a lógica de atualização usando Supabase, se quiser.
  return res.status(200).end(JSON.stringify({ ok: true, message: 'Cron pronto para implementar (SUPABASE configurado).' }));
}
