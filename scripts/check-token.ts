/**
 * Checks for the token page settings and the copy function.
 * Run with: npm run check:token. Run it again after editing src/config/token.ts.
 */
import { getAddress, isAddress } from 'viem'
import { TOKEN_PAGE, TOKENOMICS } from '../src/config/token'
import { copyText } from '../src/lib/clipboard'

let passed = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) throw new Error(`FAIL: ${name} ${detail}`)
  passed++
  console.log(`  ✓ ${name}${detail ? `  (${detail})` : ''}`)
}

async function main() {
  const T = TOKEN_PAGE
  console.log('Contract address')
  check('is a 42-character 0x address', /^0x[0-9a-fA-F]{40}$/.test(T.contractAddress))
  check('has a valid checksum (a typo in the letters would fail here)', isAddress(T.contractAddress, { strict: true }))
  check('is written in its standard checksummed form', getAddress(T.contractAddress) === T.contractAddress)

  console.log('Buy link')
  const buy = new URL(T.buyUrl)
  check('is https', buy.protocol === 'https:', buy.host)
  check(
    'contains this same contract address, so Buy and the address on the page can’t disagree',
    buy.pathname.toLowerCase().includes(T.contractAddress.toLowerCase()),
  )

  console.log('Other links and details')
  check(
    'every social link is https',
    T.social.every((s) => new URL(s.url).protocol === 'https:'),
  )
  check(
    'X link is the official account',
    T.social.some((s) => s.url === 'https://x.com/myos_app' && s.handle === '@myos_app'),
  )
  check('explorer link is empty or https', T.explorerUrl === null || new URL(T.explorerUrl).protocol === 'https:')
  check('name, ticker and chain are set', T.name === 'MYOS' && T.ticker === '$MYOS' && T.chainName.length > 0)

  console.log('Tokenomics')
  check(
    'has the five rows, each once',
    ['Total supply', 'Liquidity', 'Allocation', 'LP status', 'Taxes'].every(
      (l) => TOKENOMICS.filter((r) => r.label === l).length === 1,
    ),
  )
  check(
    'nothing is shown as fact until it is filled in (empty values are null, not made-up text)',
    TOKENOMICS.every((r) => r.value === null || r.value.trim().length > 0),
  )

  console.log('Copy function')
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const setNavigator = (value: unknown) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true })
  let written: string | null = null
  setNavigator({ clipboard: { writeText: async (t: string) => void (written = t) } })
  const ok = await copyText(T.contractAddress)
  check(
    'copies the full, exact address (all 42 characters, nothing shortened)',
    ok && written === T.contractAddress && (written as unknown as string).length === 42,
  )
  check(
    'what is copied is never the shortened display form',
    !String(written).includes('…') && !String(written).includes('...'),
  )
  setNavigator({ clipboard: { writeText: async () => Promise.reject(new Error('blocked')) } })
  check(
    'reports failure honestly when the browser blocks copying and there is no fallback',
    (await copyText(T.contractAddress)) === false,
  )
  if (original) Object.defineProperty(globalThis, 'navigator', original)

  console.log(`\nAll ${passed} token checks passed.`)
}
main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
