/**
 * The message a wallet signs to link itself to a MYOS account for rewards.
 * Shared by the app (which builds it) and the link-wallet function (which checks it).
 * It names the MYOS account, so a captured signature can't link the wallet to anyone else.
 */
export type LinkMessage = {
  domain: string
  address: string
  userId: string
  chainId: number
  issuedAt: string
}

const HEADER = 'wants to link this wallet to a MYOS account for rewards.'

export function buildLinkMessage(m: LinkMessage): string {
  return [
    `${m.domain} ${HEADER}`,
    '',
    `Wallet: ${m.address.toLowerCase()}`,
    `MYOS account: ${m.userId}`,
    `Chain ID: ${m.chainId}`,
    `Issued At: ${m.issuedAt}`,
    '',
    'This does not move any funds or cost any fees.',
  ].join('\n')
}

export function parseLinkMessage(text: string): LinkMessage | null {
  const lines = text.split('\n')
  const first = lines[0] ?? ''
  if (!first.endsWith(HEADER)) return null
  const field = (name: string) =>
    lines
      .find((l) => l.startsWith(`${name}: `))
      ?.slice(name.length + 2)
      .trim()
  const address = field('Wallet')
  const userId = field('MYOS account')
  const chainId = Number(field('Chain ID'))
  const issuedAt = field('Issued At')
  if (!address || !userId || !issuedAt || !Number.isFinite(chainId)) return null
  return { domain: first.slice(0, -HEADER.length - 1), address, userId, chainId, issuedAt }
}

/** Checks everything except the signature itself (done with viem in the function). */
export function validateLinkMessage(
  m: LinkMessage,
  expected: { userId: string; allowedDomains: string[]; now: Date; maxAgeMinutes?: number },
): string | null {
  if (m.userId !== expected.userId) return 'This signature was made for a different MYOS account.'
  if (!expected.allowedDomains.includes(m.domain)) return 'This signature was made for a different website.'
  if (!/^0x[0-9a-f]{40}$/.test(m.address)) return 'Invalid wallet address.'
  const age = (expected.now.getTime() - new Date(m.issuedAt).getTime()) / 60_000
  if (!Number.isFinite(age) || age < -2 || age > (expected.maxAgeMinutes ?? 10))
    return 'This signature has expired. Please try again.'
  return null
}
