import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getAccessToken } from './token'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const have = {
      ML_APP_ID: !!process.env.ML_APP_ID,
      ML_APP_SECRET: !!process.env.ML_APP_SECRET,
      ML_REDIRECT_URI: !!process.env.ML_REDIRECT_URI,
      ML_REFRESH_TOKEN: !!process.env.ML_REFRESH_TOKEN,
    }
    const token = await getAccessToken()
    res.status(200).json({ ok: true, have, tokenSample: token?.slice(0, 12) + '...' })
  } catch (e: any) {
    res.status(200).json({ ok: false, error: e?.message })
  }
}
