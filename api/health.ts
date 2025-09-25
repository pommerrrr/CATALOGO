
import type { VercelRequest, VercelResponse } from '@vercel/node';
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type','application/json');
  res.status(200).json({ ok:true, route:'/api/health', now:new Date().toISOString() });
}
