{
  coreutils,
  curl,
  jq,
  mosquitto,
  openssh,
  pairZigbee,
  util-linux,
  writeShellApplication,
}:

writeShellApplication {
  name = "house";
  runtimeInputs = [
    coreutils
    curl
    jq
    mosquitto
    openssh
    pairZigbee
    util-linux
  ];
  text = builtins.readFile ./house.sh;
  # Single-quoted jq programs use jq's own $variables, not the shell's.
  excludeShellChecks = [ "SC2016" ];
  meta.description = "List, inspect, identify, name, remove and add home-server devices";
}
