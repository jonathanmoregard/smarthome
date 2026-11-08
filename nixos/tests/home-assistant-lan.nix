# home-assistant-lan: the firewall half of the LAN path, exercised rather than
# restated.
#
# `vm-home-server` pins the production interface literal and
# `home-server-services` observes the listening sockets, but neither proves that
# the rule the module emits actually admits traffic on the named interface and
# refuses it everywhere else. That is the property the tailnet isolation rests
# on, because Home Assistant binds the IPv4 wildcard and so answers on every
# address it holds; only this rule separates the LAN from the tailnet.
#
# The server here carries two networks. `eth1` is named as the LAN interface,
# `eth2` stands in for any other interface the host holds - the tailnet in
# production. A client sits on each. Home Assistant itself is not started: its
# bind address is covered by `home-server-services`, and what is under test is
# the packet filter, so a stand-in listener on the same wildcard address keeps
# this check fast.
#
#   nix build --no-link .#checks.x86_64-linux.home-assistant-lan -L
{
  pkgsSystem,
}:

pkgsSystem.testers.runNixOSTest {
  name = "home-assistant-lan";
  skipTypeCheck = true;

  nodes = {
    server =
      { lib, pkgs, ... }:
      {
        imports = [ ../modules/home-assistant.nix ];

        # eth1 is the LAN; eth2 stands in for the tailnet side.
        virtualisation.vlans = [ 1 2 ];

        homeServer.homeAssistantLanInterface = "eth1";

        networking.firewall.enable = true;

        # Home Assistant's own startup is covered elsewhere and is slow. The
        # rule under test does not care which process answers, only that
        # something is bound to the wildcard address as Home Assistant is.
        systemd.services.home-assistant.wantedBy = lib.mkForce [ ];
        systemd.services.stand-in-home-assistant = {
          wantedBy = [ "multi-user.target" ];
          after = [ "network.target" ];
          serviceConfig = {
            ExecStart = "${pkgs.python3}/bin/python3 -m http.server 8123 --bind 0.0.0.0";
            Restart = "always";
          };
        };
      };

    # The driver exposes node names to the test script verbatim, so these are
    # snake_case to be addressable from Python.
    lan_client =
      { ... }:
      {
        virtualisation.vlans = [ 1 ];
        environment.systemPackages = [ pkgsSystem.curl ];
      };

    other_client =
      { ... }:
      {
        virtualisation.vlans = [ 2 ];
        environment.systemPackages = [ pkgsSystem.curl ];
      };
  };

  testScript = ''
    start_all()
    server.wait_for_unit("multi-user.target")
    server.wait_for_unit("stand-in-home-assistant.service")
    server.wait_for_open_port(8123)

    lan_client.wait_for_unit("multi-user.target")
    other_client.wait_for_unit("multi-user.target")

    # The emitted rule must name the configured interface and nothing wider.
    rules = server.succeed("iptables -S nixos-fw")
    print("[diag] nixos-fw rules mentioning 8123:\n" + "\n".join(
        line for line in rules.splitlines() if "8123" in line
    ))
    port_rules = [line for line in rules.splitlines() if "--dport 8123" in line]
    assert port_rules, rules
    for line in port_rules:
        # Shape, deliberately not identity: a rule without `-i` opens the port
        # on every interface, the tailnet included, which is what
        # `networking.firewall.allowedTCPPorts` produces. Asserting the
        # interface *name* here would only restate this node's own setting and
        # would still pass if the name were wrong; the reachability checks
        # below are what establish that the right interface was named.
        assert " -i " in line, line

    server_lan_ip = server.succeed(
        "ip -4 -o addr show eth1 | awk '{print $4}' | cut -d/ -f1"
    ).strip()
    server_other_ip = server.succeed(
        "ip -4 -o addr show eth2 | awk '{print $4}' | cut -d/ -f1"
    ).strip()
    print(f"[diag] server lan={server_lan_ip} other={server_other_ip}")

    # Reachable across the named interface.
    lan_client.wait_until_succeeds(
        f"curl -fsS --max-time 5 http://{server_lan_ip}:8123/ -o /dev/null", timeout=60
    )

    # Refused across any other interface, even though the listener answers on
    # the wildcard address and the port is open on the LAN. Were the rule
    # emitted without an interface match, this would succeed.
    other_client.fail(
        f"curl -fsS --max-time 5 http://{server_other_ip}:8123/ -o /dev/null"
    )

    # The server reaches its own wildcard listener regardless; this separates
    # "the filter blocked it" from "nothing was listening".
    server.succeed(f"curl -fsS --max-time 5 http://{server_other_ip}:8123/ -o /dev/null")
  '';
}
