# Recording the pitch and the demo

Colosseum asks for two videos: a 2 to 3 minute pitch and a demo of at most 3 minutes. The pitch
sells the customer, the problem and the evidence; the demo proves the mechanism works. Keep
them separate.

Everything in the demo runs on the live app (https://mandate-lac-rho.vercel.app) on devnet,
driven by the simulated test network. Say once, early, that the participants are simulated:
it is a reproducible demonstration, not traction.

## Before you record

1. Keep the network running in a terminal (the coloured log makes good B-roll):

   ```bash
   CLUSTER=devnet RPC_URL=https://api.devnet.solana.com npx tsx scripts/simulate.ts run
   ```

2. Browser at about 1440×900, light mode. Open the landing page, `/app`, and `/app/create`.
3. About six minutes before recording the breach, start a fresh one in a second terminal. The
   maker quotes for two minutes, withdraws, and the breach and settlement follow within about
   four minutes:

   ```bash
   CLUSTER=devnet RPC_URL=https://api.devnet.solana.com npx tsx scripts/simulate.ts scene walkaway 2
   ```

   Open the new KITE agreement from the network board as soon as it appears.

## Demo (under 3 minutes): one agreement, start to settlement

| Time | Screen | Say |
|---|---|---|
| 0:00 | Draft an agreement: "Your operator", then the plain-words preview | "A token team puts its existing liquidity operator under an agreement. Both sides read the same terms in plain words: what the team supplies, what the operator locks, what earns pay, what triggers the penalty, when it ends." |
| 0:25 | A live agreement's status page: banner and service levels | "The inventory sits in a vault the operator can only quote from. Anyone can check at any time; each tick is one scoring period." |
| 0:45 | The committed book and "What a trader gets right now" | "What is enforced is committed liquidity near the reference price, valued bin by bin, so trades can't fake it. Execution at each size is shown next to it but not enforced." |
| 1:05 | Terminal: `scene sandwich`; the feed line | "An attacker buys out the asks and forces a check in the same transaction. The check still passes: that's why we measure commitment, not the momentary book." |
| 1:25 | The walk-away agreement: Operational, then failed checks | "This operator pulled its liquidity. The checks fail, the watchtower checks it more often, and the incident log records why." |
| 1:55 | Breach: banner, incident, settlement receipt with transaction links | "Three failed periods in a row: half the bond goes to the team, and settlement returns the inventory and unused fees to the team and the earned fees and remaining bond to the operator." |
| 2:30 | Maker ratings | "Every closed period is written to the operator's public record." |
| 2:45 | Landing page | "Mandate: restricted custody and automatic settlement for liquidity agreements. Live on devnet." |

## Pitch (2 to 3 minutes)

- **Who it's for.** A funded Solana token team that already pays a liquidity operator and has
  quote capital. They have a budget, an existing workflow and a renewal coming up.
- **The problem.** To get liquidity managed, the team hands inventory to the operator and
  settles on the operator's own report. Monitoring tools exist; what's missing is keeping
  control of the inventory and settling automatically on verified commitments.
- **What's different.** Restricted custody (the inventory can only be quoted and comes back),
  a bond, and settlement that follows the checks. Measuring committed liquidity bin by bin
  means trading can't fake a pass or force a fail.
- **Evidence.** Say only what you have: the working mechanism on devnet, and the customer and
  operator conversations from [validation.md](validation.md), including the terms you changed
  because an operator objected. Don't use market-maker retainer figures unless you can source
  them, and present the pool study as exploratory (a snapshot of new pools, not a count of
  buyers).
- **Business.** Start with designated operators for individual teams and a monthly
  monitoring and administration fee, not slashing revenue (a working agreement should rarely
  slash). Then curated launchpads that repeat the setup, then broader agreement
  infrastructure if the demand is there.
- **You.** Why you understand this problem.

## Claims to avoid

| Don't say | Say instead |
|---|---|
| "Nobody can check whether they delivered" | "Monitoring exists; Mandate adds restricted custody and automatic settlement" |
| "Every token from the launchpad graduates with a maker under contract" | "Unsold supply moves into escrow as inventory; the team adds quote tokens and a fee budget, and a maker accepts" |
| "Uptime" or "guaranteed liquidity" | "Committed liquidity near the reference, with execution shown alongside" |
| "95% of pools prove the market" | "In a snapshot of new pools, most were too thin to absorb small trades; the customers are funded teams" |
| Unsourced retainer figures | Figures from your own interviews, attributed |
