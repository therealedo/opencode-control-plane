export function shouldNotifyRenewal(daysUntilRenewal) {
  return Number.isInteger(daysUntilRenewal) && daysUntilRenewal > 0 && daysUntilRenewal < 30
}
