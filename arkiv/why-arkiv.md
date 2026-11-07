# Why Arkiv

## If this data sat in Postgres, what would users lose?

1. **Independence from us.** Balloon tracking today runs through central services.
   SondeHub, the amateur network, works because hundreds of volunteer receivers
   send it data ([SondeHub tracker guide](https://github.com/projecthorus/sondehub-tracker/wiki/SondeHub-Tracker-User-Guide)),
   but it is one service with one operator. With Postgres we would be another one.
   On Arkiv the map reads the chain directly: our server can go away and the track
   still loads.
2. **Who said what.** Every packet is owned by the wallet of the receiver that
   heard it. With Postgres, our server writes every row and readers have to trust
   that we copied each receiver honestly. On Arkiv a receiver signs its own rows
   and nobody else can edit them.
3. **Re-checking.** Each packet keeps the 28 raw bytes as heard, and each signature frame
   its 100 raw bytes (`boscon.hab.sig`). Anyone can take the beacon's public key and re-run
   the signature check from Arkiv alone, without asking us: our [MCP server](../mcp/README.md)
   does exactly that, and for session `live-11062318` finds 105 frames verified, all 3
   forged frames caught, and no receiver verdict that fails the check.
4. **Live without us.** The public site ([hab-1.vercel.app](https://hab-1.vercel.app)) has
   no backend: it follows the newest session straight from Arkiv every 20 s. With Postgres it
   would need our API to be up.

## What we kept off Arkiv, and why

| Kept off | Why |
|---|---|
| Camera footage (45 GiB from the 31 Oct flight) | Far beyond the 128 KiB a `bytes` value holds; it belongs on file storage such as Swarm |
| The full 1 Hz flight log (51,622 records) | Only the frames that went over the radio matter to people tracking a flight |
| Private keys, the hotspot login | Never on any shared store |
| Frames before their signature arrives | A frame is written only once its batch signature has been checked, so nothing unverified is published as verified |
