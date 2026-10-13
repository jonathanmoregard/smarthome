# Access

SSH is restricted to the operator's configured keys and Tailscale access. Home
Assistant is exposed through the configured Tailscale service; share the host
through Tailscale's node-sharing controls when household access is needed.

The system deployer uses HTTPS origin access and cache signature verification.
Do not alter deploy trust keys or agenix identities during routine access work.
