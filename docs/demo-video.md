# Recording the demo

Everything below runs against the live app (https://mandate-lac-rho.vercel.app) on devnet,
driven by the simulated test network. The participants are fictional and marked **SIM** in
the app; their transactions are real.

## Before you record

1. Keep the network running in a terminal (its coloured log makes good B-roll):

   ```bash
   CLUSTER=devnet RPC_URL=https://api.devnet.solana.com npx tsx scripts/simulate.ts run
   ```

2. Browser at about 1440×900, light mode, zoom 100%. Open the landing page, `/app`, the ORBT
   SLA and `/app/makers` in tabs.
3. About six minutes before you record the breach, start a replay in a second terminal. Lazy
   Capital quotes for two minutes, walks away, and the breach lands about four minutes later:

   ```bash
   CLUSTER=devnet RPC_URL=https://api.devnet.solana.com npx tsx scripts/simulate.ts scene walkaway 2
   ```

   Open the new KITE SLA from the network board as soon as it appears, so you can film it
   turning from Operational to Degraded to Breached.

## Demo video (under 3 minutes)

| Time | Screen | Say |
|---|---|---|
| 0:00 | Landing hero, then scroll to the live board | "Token issuers pay market makers to keep their markets liquid, and nobody can check whether they did. Mandate turns that promise into a liquidity SLA with a public status page." |
| 0:15 | Click ORBT/USDC: the green banner, then hover the service-level ticks | "Each tick is one scoring period. Bid depth, ask depth and spread are each measured, period by period, by the program." |
| 0:35 | Committed book and the routability line | "This is the maker's committed liquidity around a reference price that follows the pair's TWAP. A 500 USDC round trip costs a fraction of a percent, so the token stays routable." |
| 0:55 | Network page, live feed; run `scene sandwich` in the terminal | "Anyone can check the maker at any moment. Here an attacker buys out the asks and forces a check in the same transaction. It still passes: liquidity is valued bin by bin." |
| 1:25 | The walk-away SLA: Degraded, then Breached | "This maker pulled its quotes. Checks fail, three missed periods slash half its bond, and the watchtower settles: the inventory goes back to the issuer." |
| 1:55 | Incident log and the slash and settle lines in its feed | "The whole incident is on-chain and public, not in a monthly report the maker writes itself." |
| 2:10 | Maker ratings | "Every closed period is written to the maker's profile. Helios is AAA; the maker that walked is rated D." |
| 2:25 | Draft an SLA: pick a profile, watch the contract update | "An issuer drafts terms in a minute, funds the escrow, and any maker can accept by posting a bond." |
| 2:40 | Launchpads page | "Launchpads route each token's unsold supply into its SLA at graduation, so every token launches with a market maker under contract." |
| 2:50 | Back to the landing hero | "Mandate: uptime for token markets. Live on Solana devnet." |

## Pitch video talking points (2 to 3 minutes)

- **The problem.** Of 2,755 newly graduated launchpad pools we measured on Solana, 95.4% could
  not absorb one cent without the price moving 2%. Tokens that pay for market making pay
  retainers of $10K to $50K a month on trust.
- **Why now.** The MOVE market-maker dump and the Gotbit prosecution showed what unaccountable
  market making costs holders. Launches on Solana run to millions per quarter; launchpads need
  a reason for creators to choose them.
- **The insight.** A market maker's obligations (depth, spread, uptime) are measurable
  on-chain at any moment, so they can be enforced by a program rather than a contract.
- **The product.** Escrowed inventory that can only be quoted, random public checks that
  trading cannot fake, pay per compliant period, and a slashable bond, with a status page
  and a rating anyone can recompute.
- **Go to market.** Launchpads first: one DBC config change gives every graduating token an
  SLA. Then funded projects that already pay market makers, and makers who want a record they
  can sell on.
