# Recording the pitch and the demo

Colosseum asks for two videos: a 2 to 3 minute pitch and a demo of at most 3 minutes. The pitch
sells the customer, the problem and the evidence; the demo proves the mechanism works. Keep
them separate.

Everything in the demo runs on the live app (https://mandate-lac-rho.vercel.app) on devnet,
driven by the simulated test network. Say once, early, that the participants are simulated:
it is a reproducible demonstration, not traction. Show both an ordinary agreement that is paid
and renewed and a failure that ends in recovery; the first is why customers would keep paying.

## Before you record

1. Keep the network running in a terminal (the coloured log makes good B-roll):

   ```bash
   CLUSTER=devnet RPC_URL=https://api.devnet.solana.com npx tsx scripts/simulate.ts run
   ```

2. Browser at about 1440×900, light mode.
3. About 20 minutes before recording, start the successful path in a second terminal: Nova drafts
   a six-period ORBT agreement for Helios, Helios counter-proposes a smaller bond, both sign, Nova
   funds exactly that version, Helios quotes and is paid, and the renewal is drafted from the
   record, approved again and funded. The log prints the draft links and the renewal report.

   ```bash
   CLUSTER=devnet RPC_URL=https://api.devnet.solana.com npx tsx scripts/simulate.ts scene term 6
   ```

4. About six minutes before recording the failure, start one in a third terminal. Lazy Capital
   quotes for two minutes, withdraws, and the breach and settlement follow within about four:

   ```bash
   CLUSTER=devnet RPC_URL=https://api.devnet.solana.com npx tsx scripts/simulate.ts scene walkaway 2
   ```

5. In the app, start Monitor on the test network's ORBT pool a few minutes early, so the report
   has evidence to show.

## Demo (under 3 minutes): the customer's journey, then the failure it survives

| Time | Screen | Say |
|---|---|---|
| 0:00 | Overview: the two entry points | "A token team already pays a liquidity operator. It starts here, without a wallet." |
| 0:10 | Monitor on the ORBT pool: operator found, periods filling, evidence panel | "Point it at the pool. It samples the operator's book at random times with the program's own arithmetic, and says when there's enough evidence and what's missing." |
| 0:35 | The replay and trader table; change the depth, the replay updates | "The same observations replay against any terms. Committed depth and what traders could actually execute are reported separately." |
| 0:50 | "Draft terms from this" → the draft: feasibility, inventory cover, the what-if | "The draft starts from what was delivered. Before anyone signs: what each side puts in, what the inventory covers, how the rules would have played out, and what can't be concluded." |
| 1:15 | The scene's draft link: version 2 by the operator, both approvals | "The operator pushed back on the bond. Both sides signed the same terms hash; only that version can be funded." |
| 1:30 | The funded agreement's status page, then its renewal report | "It ran its term: paid for every compliant period. The renewal report separates fees, unused budget and penalties, and proposes changes from the record." |
| 1:55 | The walk-away agreement: failed checks, breach, closing report and handover | "When an operator walks away, the checks fail, the bond is slashed, the inventory comes back, and the handover invites a new operator. The gap is on the record." |
| 2:30 | Operator queue, viewed as Helios | "Operators get a work queue: what changed since the last passing check, a simulated action to approve, and the watchtower's read, which they rate." |
| 2:45 | Overview | "Mandate: monitor, agree, and renew liquidity management with custody and settlement on chain. Live on devnet." |

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
