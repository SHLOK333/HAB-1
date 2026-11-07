# HAB-1 on Arkiv, over MCP

Track the HAB-1 balloon from an AI assistant without trusting the HAB-1 team.

This MCP server reads the flight straight from the public [Arkiv](https://arkiv.network) chain
(Rabdi testnet). It holds no keys and calls no server of ours. Every position it gives you has
been re-checked on your own machine against the beacon's signature, from the raw radio bytes
stored on Arkiv.

## What you trust, and what you don't

| You trust | You do not need to trust |
|---|---|
| The beacon's Ed25519 public key. Pass your own copy as `beacon_key`; the beacon prints it with its `pubkey` command. | The HAB-1 team, its server or its website |
| This code, which is short: [`verify.mjs`](verify.mjs) is 72 lines and uses Node's own crypto | Any receiver, including ours: a receiver's verdict is compared with your own check, and any that doesn't hold up is listed |
| The Arkiv chain to return what was written | Arkiv's indexed attributes: positions are decoded from the signed bytes, not read from the attributes |

**How the check works** (frame layouts in [`firmware/hab_node/frames.h`](../firmware/hab_node/frames.h)):

1. Every 7th radio slot the beacon sends a SIG frame: 6 truncated `SHA-256(salt + frame)` hashes, the salt and a boot counter, signed with Ed25519.
2. The ground station stores each data frame (`boscon.hab.packet`, 28 raw bytes) and each SIG frame (`boscon.hab.sig`, 100 raw bytes) on Arkiv.
3. This server checks each SIG frame's signature with the key you trust. A data frame then counts as verified only if its own salted hash appears in a valid SIG frame.

A forged frame fails step 3. A changed byte, a changed salt or a different key fails step 3 as well. [`selftest.mjs`](selftest.mjs) tests each of these on real radio bytes from 7 Nov 2026.

Mission data (winds, landing predictions, 0G AI analyses) is our own analysis. Nothing signs it
in flight, so it is read from the HAB-1 ground-station wallet
`0x532cCE61F117A394D595E9fb7069f4D6CE3Bb047` by default, and the results say so.

## Install

Needs Node 20 or later.

```bash
git clone https://github.com/SHLOK333/HAB-1 && cd HAB-1/mcp && npm install
npm test                    # offline checks, then the MCP tools against Arkiv
```

**Claude Code:**

```bash
claude mcp add hab1 -- node "$PWD/server.mjs"
```

**Claude Desktop, Cursor, or another MCP client.** Add this to its MCP config:

```json
{ "mcpServers": { "hab1": { "command": "node", "args": ["/absolute/path/to/HAB-1/mcp/server.mjs"] } } }
```

Two optional environment variables:

- `ARKIV_ACCESS_KEY`: your own free key from [hub.arkiv.network](https://hub.arkiv.network/access-keys). Without one, Arkiv's public endpoint is rate limited.
- `HAB1_BEACON_KEY`: the beacon key to trust, instead of the one pinned in this repo.

## Tools

| Tool | What it gives you |
|---|---|
| `list_sessions` | Sessions on Arkiv, newest first, with the wallet that recorded each one |
| `verify_session` | Your own check of a whole session: valid signature frames, verified, forged and unprovable frames, and any receiver whose verdict fails |
| `get_track` | The flight path from frames you verified, in time order |
| `latest_position` | The newest verified position, with a map link and the proof |
| `query_packets` | Arkiv attribute queries (altitude, area, verdict, receiver), including the raw bytes |
| `get_winds` | Measured and GFS winds by altitude |
| `get_landing_predictions` | Hindcast, in-flight and forecast landing predictions, with their error |
| `get_ai_insights` | 0G analyses of the Arkiv data, each with its model, 0G request ID and the claim check by a second 0G model |
| `decode_frame` | Decodes any HAB-1 radio frame, and checks a SIG frame's signature |

Things to ask:

- "Where is the HAB-1 balloon now? Prove it."
- "Verify the newest session. Did any receiver vouch for a frame the beacon didn't sign?"
- "Which frames in session live-11062318 were forged, and where did they claim the balloon was?"
- "What did 0G conclude about the jet stream, and did the claim check pass?"

## Limits

- **Frame lifetime:** frames expire from Arkiv 7 days after they are written, and sessions after 30 days.
- **Signature frames on Arkiv:** stored since 7 Nov 2026, and backfilled for the sessions of 6 and 7 Nov. Older sessions show "no signature frame on Arkiv".
- **Lost signature frames:** a frame whose SIG frame was never heard can't be proven. This happens if the radio lost the SIG, or the beacon restarted before sending it. Such frames are listed, never counted as verified.
- **Replays:** this server reports the boot counters it sees. It doesn't rebuild the ground station's replay ordering, because Arkiv doesn't record the order in which frames were heard.
