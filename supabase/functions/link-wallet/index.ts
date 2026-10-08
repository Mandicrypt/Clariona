// Supabase Edge Function: link a wallet to the signed-in MYOS account for rewards.
//
// The browser sends a message signed by the wallet. This function (not the browser)
// checks the signature, that the message names this account and this site, and
// that it is recent. Only then is the wallet stored, using the service role.
// Deploy:  supabase functions deploy link-wallet
// Secrets: MYOS_ALLOWED_DOMAINS (comma-separated hosts, e.g. "myos-alpha.vercel.app")

import { createClient } from 'npm:@supabase/supabase-js@2'
import { verifyMessage } from 'npm:viem@2'
import { parseLinkMessage, validateLinkMessage } from '../_shared/link-message.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST' })

  const url = Deno.env.get('SUPABASE_URL')!
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const allowedDomains = (Deno.env.get('MYOS_ALLOWED_DOMAINS') ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean)

  // Who is asking: taken from their Supabase session, never from the request body.
  const asUser = createClient(url, anon, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: auth } = await asUser.auth.getUser()
  if (!auth.user) return reply(401, { error: 'Sign in first.' })

  const { message, signature } = (await req.json().catch(() => ({}))) as { message?: string; signature?: `0x${string}` }
  if (!message || !signature) return reply(400, { error: 'Missing message or signature.' })
  const parsed = parseLinkMessage(message)
  if (!parsed) return reply(400, { error: 'Unrecognised message.' })
  const problem = validateLinkMessage(parsed, { userId: auth.user.id, allowedDomains, now: new Date() })
  if (problem) return reply(400, { error: problem })

  const valid = await verifyMessage({ address: parsed.address as `0x${string}`, message, signature }).catch(() => false)
  if (!valid) return reply(400, { error: 'The signature does not match this wallet.' })

  const admin = createClient(url, service)
  const { data: existing } = await admin
    .from('wallets')
    .select('id, user_id')
    .eq('chain', 'eip155')
    .eq('address', parsed.address)
    .maybeSingle()
  if (existing && existing.user_id !== auth.user.id)
    return reply(409, { error: 'This wallet is already linked to another MYOS account.' })
  if (existing) return reply(200, { walletId: existing.id, address: parsed.address, alreadyLinked: true })

  const { data: created, error } = await admin
    .from('wallets')
    .insert({
      user_id: auth.user.id,
      chain: 'eip155',
      address: parsed.address,
      last_network: `eip155:${parsed.chainId}`,
      linked_via: 'signature',
    })
    .select('id')
    .single()
  if (error) return reply(500, { error: 'Could not save the wallet.' })
  return reply(200, { walletId: created.id, address: parsed.address, alreadyLinked: false })
})
