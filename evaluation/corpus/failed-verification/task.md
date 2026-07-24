# Repair commission calculation

Repair `commissionCents(premiumCents, basisPoints)` so it accepts non-negative safe-integer cents and integer basis points from 0 through 10,000, rounds half up to the nearest cent without intermediate floating-point loss, and rejects unsafe results or invalid inputs. Keep the export and add no dependencies or network access.
