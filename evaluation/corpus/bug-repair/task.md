# Repair renewal notification boundaries

`shouldNotifyRenewal(daysUntilRenewal)` incorrectly excludes renewals due today and exactly 30 days away.

Repair it so integer days from 0 through 30 are included. Negative, fractional, non-number, and values above 30 must return `false`. Keep the public function and add no dependencies or network access.
