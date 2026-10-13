# Secrets

Only ciphertext belongs in Git. The Zigbee network key is stored in
`nixos/secrets/zigbee2mqtt-network-key.age` and decrypted by agenix into
`/run/agenix` at activation.

Never print decrypted secrets, place them in the Nix store, or change the
coordinator identity as part of routine recovery. Verify ownership, mode, and
consumer health instead.
