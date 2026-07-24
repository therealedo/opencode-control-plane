export function commissionCents(premiumCents, basisPoints) {
  if (!Number.isSafeInteger(premiumCents) || premiumCents < 0) {
    throw new TypeError("premium cents must be a non-negative safe integer")
  }
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new TypeError("basis points must be an integer from 0 through 10000")
  }
  const result = (BigInt(premiumCents) * BigInt(basisPoints) + 5_000n) / 10_000n
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("commission exceeds safe integer range")
  return Number(result)
}
