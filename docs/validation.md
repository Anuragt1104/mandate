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

## The loop the app now supports, and what to measure at each step

| Step in the app | Signal to record | Why it matters |
|---|---|---|
| Monitor an existing arrangement (Reports) | Sessions started; share of sessions reaching "enough evidence" | Teams will point it at a live operator without a wallet or deposit |
| Share the service report | Reports shared; **reports that led to a payment, remediation or renewal decision** (ask the team) | The report is worth something before any custody change |
| Draft terms from the report | Drafts started from a report vs from scratch | Observed terms are a better starting point than presets |
| Operator proposes changes | Which clauses each version changes, and the notes (the version log in the draft) | Clauses that repeatedly block agreement are the product's constraints |
| Both approve, team funds | Drafts reaching both approvals; time from first draft to funding | A team and an operator can agree terms without us in the room |
| Renewal report → renew | Terms renewed, with which changes; **second term paid without a subsidy** | The market-fit signal |
| Operator queue | Alerts marked useful / not useful / dismissed; alerts raised while checks still passed | Whether the watchtower's prioritisation (Jev) helps an operator's day |

The app keeps these in the user's browser (it has no server), so record them in the pilot log below
from the links people send and short check-ins. Track support time per pilot next to the fee.

## The paid pilot to offer

"Independent verification of your liquidity agreement, with restricted custody and automated
settlement as an option." Start by monitoring the existing arrangement read-only (Monitor in the
app for a first look; `scripts/verify.ts` for unattended days, imported under Reports), share a
report each week, and only then draft the escrowed agreement with the same operator from what
was observed. Price it as a
monthly monitoring and administration fee; slashing should rarely happen when things work.
Onboarding and support may cost more than a small fee brings in, so measure the effort next to
the price.

## Objection log

Record every objection and what changed because of it. "We changed the contract after an
operator identified an unacceptable risk" is stronger evidence than a list of endorsements.

| Date | Who (role) | Objection | What we changed |
|---|---|---|---|
| | | | |
