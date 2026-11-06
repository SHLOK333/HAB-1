# Reach

## Who is it for, and would they use it?

- **High-altitude balloon teams** like ours, who need a track that keeps working
  when one ground station or server fails. Boscon Space flew HAB-1 on 31 Oct 2026
  (burst 19.6 km, landed 62.7 km from the pad). Our ground station missed the last
  7 minutes of that flight; a shared record from several receivers is the fix.
- **Amateur receiver operators.** The radiosonde community already runs hundreds of
  volunteer receivers feeding one central service (SondeHub). Owning their own
  records on Arkiv gives them the same shared map without depending on one operator.
- **Recovery crews**, who need the last known positions fast, from whichever
  receiver heard the payload last.

## Can they try it today?

Yes, read only: `node arkiv/query.mjs`, or the map in `web/index.html`. Both read the
testnet with no key and no account. On the map, click anywhere to list every packet heard
near that point, from every session and receiver, which is what a recovery crew needs.
Writing needs a funded testnet wallet and the radio hardware. The map is one static file:
open it from the repository, or any static host.

What a second receiver adds is shown in session `three-receivers-20261104`: each frame, and
the wallets that vouched for it. Two of those three receivers are simulated (we have one
ground radio), and are labelled so.

## Will we keep building after Mumbai?

Yes. The next HAB flight is the first real use: the beacon's signatures go into the
flight firmware, and the ground station publishes live to Arkiv during the flight.
What we have not done yet: a second real receiver, and putting the map itself on
storage we do not control (it is a single static file, so any host or Swarm will do).
