export function commissionCents(premiumCents, basisPoints) {
  return Math.floor((premiumCents * basisPoints) / 10_000)
}
