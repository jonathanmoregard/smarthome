# Bootstrap

Install the NixOS host configuration, provision the agenix identity, and
verify the encrypted Zigbee network key before enabling the system deployer.
The first successful deployment should verify:

```console
systemctl is-enabled system-deploy.timer
systemctl list-timers system-deploy.timer
systemctl is-active sshd tailscaled mosquitto
```

Keep the production Zigbee identity and deployment trust configuration intact.
