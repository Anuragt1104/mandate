# Validating demand

The devnet network proves the mechanism works. It does not prove anyone wants it. The riskiest
assumption is that a paying token team and a competent operator will both accept the same
economically viable terms. These are the next tests, with the thresholds that decide whether
to continue, change direction or stop. The thresholds are our own gates, not industry
benchmarks.

## Who to talk to first

A funded Solana token team that already pays a liquidity operator, holds quote capital, and is
near a renewal or unhappy with the reporting. Launchpads come later, as a distribution partner
once one agreement has worked end to end. Anonymous, short-lived launches are a weak first
segment: uncertain budget, no accountable buyer.

## Gates for the next 30 days

| Test | Pass if |
|---|---|
| Interview 10 qualified teams | At least 5 describe a recent oversight problem and share a redacted agreement, report or incident |
| Review terms with 5 operators | At least 2 quote a fee and the bond and exception terms they would accept |
| Run 3 monitoring pilots (`scripts/verify.ts`) | Teams use the reports in a real payment, renewal or remediation decision |
| Compare committed liquidity with execution | Every material "the agreement passes, trading was poor" case is explained |
| Present one complete agreement | One team and one operator accept the same inventory, fee, bond, monitoring and exception terms |

Change direction or stop if teams only want price support, operators reject enforcement at
fees teams will pay, or nobody pays without a subsidy. Renewals after a pilot are the evidence
for market fit, not the pilot itself.

## Interview: token team (30 minutes)

Bring a real agreement from the app, printed in plain words (Draft an agreement, "Plain
words").

1. Who manages your liquidity today, on what terms, and what do you pay? How did you choose them?
2. What do you get as proof they delivered? When did you last question it?
3. Tell me about the last time liquidity was worse than you expected. What did you do?
4. What happens to the tokens you lend them? Could you get them back tomorrow?
5. Read this agreement. Which term would stop you signing it?
6. Where would the quote tokens and the fee budget come from?
7. Would you run a pilot that only monitors your current operator, with no escrow? What would
   the report have to show to change a payment or renewal?

## Interview: liquidity operator (30 minutes)

1. What do your agreements usually require, and how do clients check it today?
2. Read this agreement. What capital is locked, for how long, at what return, and is it enough?
3. Could the reference price's speed limit stop you rebalancing sensibly? What would?
4. What should count as an exception: exchange outages, extreme volatility, RPC failures? Who
   should prove it?
5. What fee, bond and penalty would you accept for this token? What would make you walk away?
6. Would a public, verifiable record of met periods help you win clients?

## The paid pilot to offer

"Independent verification of your liquidity agreement, with restricted custody and automated
settlement as an option." Start by monitoring the existing arrangement read-only
(`scripts/verify.ts` against the operator's DLMM position on mainnet), deliver a report each
week, and only then move the same team and operator into an escrowed agreement. Price it as a
monthly monitoring and administration fee; slashing should rarely happen when things work.
Onboarding and support may cost more than a small fee brings in, so measure the effort next to
the price.

## Objection log

Record every objection and what changed because of it. "We changed the contract after an
operator identified an unacceptable risk" is stronger evidence than a list of endorsements.

| Date | Who (role) | Objection | What we changed |
|---|---|---|---|
| | | | |
