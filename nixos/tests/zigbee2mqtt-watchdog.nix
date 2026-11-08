# Contract for the Zigbee2MQTT watchdog. No VM: the behaviour worth pinning is
# when the script acts and when it refuses to, which is exercised far more
# thoroughly against stubbed systemctl and mosquitto_sub than it could be
# against a VM whose Zigbee radio is a null character device and whose bridge
# therefore never comes online at all.
{ pkgs, script, driver }:

pkgs.runCommand "zigbee2mqtt-watchdog-contract"
{
  nativeBuildInputs = [ pkgs.bash pkgs.coreutils ];
}
''
  # Deliberately not piped into tee: a pipeline reports the last command's
  # status, so `| tee "$out"` would have this derivation succeed on every
  # failing check.
  if bash ${driver} ${script} > "$out"; then
    cat "$out"
  else
    cat "$out"
    exit 1
  fi
''
