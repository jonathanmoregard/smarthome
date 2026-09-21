{
  coreutils,
  jq,
  mosquitto,
  openssh,
  writeShellApplication,
}:

writeShellApplication {
  name = "pair-zigbee";
  runtimeInputs = [
    coreutils
    jq
    mosquitto
    openssh
  ];
  text = builtins.readFile ./pair-zigbee.sh;
  meta.description = "Open Zigbee pairing on the home server for a bounded window";
}
