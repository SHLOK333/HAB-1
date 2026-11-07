# Reach

## Who is it for, and would they use it?

- **High-altitude balloon teams like ours.** They need a track that keeps working when one ground station or server fails. Boscon Space flew HAB-1 on 31 Oct 2026 (burst at 19.6 km, landed 62.7 km from the pad). Our ground station missed the last 7 minutes of that flight. A shared record that any receiver can add to fixes that, and readers don't have to trust whoever runs the website.
- **Amateur receiver operators.** The radiosonde community already runs hundreds of volunteer receivers that feed one central service ([SondeHub](https://github.com/projecthorus/sondehub-tracker/wiki/SondeHub-Tracker-User-Guide)). On Arkiv, each operator owns their own records, under their own wallet, and the shared map doesn't depend on any single operator.
- **Recovery crews.** They need the last verified position fast, from whichever receiver heard the payload last.
- **AI agents and their users.** Someone can ask an assistant "where is the balloon, prove it". The assistant reads Arkiv directly and checks the beacon's signatures itself (the [MCP server](../mcp/README.md)).

## Can they try it today?

Yes. Nothing below needs an account, a key, or our laptop to be on.

| Try | How | What you get |
|---|---|---|
| The live site | [hab-1.vercel.app](https://hab-1.vercel.app) | While a hardware session runs, the map follows it **live from Arkiv** ("Live · Arkiv"): it polls the newest session every 20 s and plays new frames about a minute behind the radio. Otherwise it plays any recorded session from the session list. |
| Attribute queries in your browser | [hab-1.vercel.app/#/arkiv](https://hab-1.vercel.app/#/arkiv) | Presets such as "Jet stream ≥ 20 m/s", "10–15 km", "Miss ≤ 1 km" and "Forged frames", each one Arkiv query run from your browser |
| 0G analyses of the Arkiv data | [hab-1.vercel.app/#/zerog](https://hab-1.vercel.app/#/zerog) | Each analysis states which Arkiv filter it read, the 0G model that wrote it, and whether a second 0G model found any claim the data does not support |
| An AI assistant | `cd mcp && npm install && claude mcp add hab1 -- node $PWD/server.mjs` | 9 tools, including `verify_session`, which re-checks every frame's Ed25519 signature from the raw bytes on Arkiv |
| The command line | `cd arkiv && npm install && node query.mjs retest-1106` | Sessions and packets, read with no key |

**What is on Arkiv now** (ground-station wallet `0x532c…b047`, read on 7 Nov 2026):

- 11 sessions
- 2,160 frames: 2,087 verified and 13 forged, rejected and kept as evidence
- 372 signature frames
- 144 wind measurements
- 128 landing predictions
- 33 public balloon positions
- 22 0G analyses

**Measured for session `live-11062318`:** a stranger running the MCP, with no key of ours, finds:

- all 19 of 19 signature frames valid
- 105 frames verified
- all 3 forged frames caught
- no receiver verdict that fails their own check

Writing needs the radio hardware and a funded testnet wallet.

## Will we keep building after Mumbai?

Yes. The next HAB flight is the first real use. The beacon's signatures go into the flight firmware, and the ground station publishes to Arkiv live during the flight, as it does on the bench now.

Not done yet:
- a second real receiver (the two others we have written with are simulated, and labelled as such);
- putting the site itself on storage we don't control, such as Swarm. It is a static folder, so any host will do.
