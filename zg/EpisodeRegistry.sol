// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Records where each episode log of the balloon payload lives on 0G Storage.
/// An episode log is the payload's list of decisions: one JSON line per checkpoint,
/// with the 0G request id, the action taken and the payload's own Ed25519 signature.
/// Only the recorder (the ground station that uploads the logs) can add entries;
/// anyone can read them and fetch the log from 0G Storage by its root hash.
contract EpisodeRegistry {
    struct Episode {
        bytes32 root;        // 0G Storage merkle root of the episode log file
        uint32 decisions;    // number of decision records in the file
        uint32 safeStops;    // how many of them were safe stops (0G unreachable)
        uint64 recordedAt;   // block timestamp
    }

    address public immutable recorder;
    bytes32 public immutable payloadKey;   // the payload Pi's Ed25519 public key
    mapping(string => Episode[]) private runs;

    event EpisodeRecorded(string run, bytes32 indexed root, uint32 decisions, uint32 safeStops, uint256 index);

    constructor(bytes32 payloadKey_) {
        recorder = msg.sender;
        payloadKey = payloadKey_;
    }

    function record(string calldata run, bytes32 root, uint32 decisions, uint32 safeStops) external {
        require(msg.sender == recorder, "only the recorder");
        runs[run].push(Episode(root, decisions, safeStops, uint64(block.timestamp)));
        emit EpisodeRecorded(run, root, decisions, safeStops, runs[run].length - 1);
    }

    function count(string calldata run) external view returns (uint256) {
        return runs[run].length;
    }

    function latest(string calldata run) external view returns (Episode memory) {
        uint256 n = runs[run].length;
        require(n > 0, "no episodes for this run");
        return runs[run][n - 1];
    }
}
