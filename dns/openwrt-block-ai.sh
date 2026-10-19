#!/bin/sh
# DNS backstop for unapproved AI sites on OpenWrt (dnsmasq).
# Run ON the router:  sh openwrt-block-ai.sh apply | remove | status
#
# This only affects devices that use the router for DNS, and only while they
# are on that network. It is a backstop for unmanaged browsers and apps; the
# browser extension is the main control on company devices.
#
# Personal devices: put them on a guest network / separate dnsmasq instance
# that does NOT use this list, and don't log their queries.
#
# NOT run automatically by anything in this repo. Review before applying.

set -eu

DOMAINS="
gemini.google.com
copilot.microsoft.com
perplexity.ai
chat.deepseek.com
deepseek.com
chat.mistral.ai
grok.com
poe.com
character.ai
meta.ai
you.com
chat.qwen.ai
kimi.com
kimi.moonshot.cn
chatglm.cn
pi.ai
"

# Uses the standard uci "address" list on the main dnsmasq instance, so it
# survives reboots and doesn't touch dnsmasq's confdir (other packages use it).
# address=/domain/ with no IP answers NXDOMAIN for the domain + subdomains.
case "${1:-status}" in
  apply)
    for d in $DOMAINS; do
      uci -q del_list dhcp.@dnsmasq[0].address="/$d/" || true
      uci add_list dhcp.@dnsmasq[0].address="/$d/"
    done
    uci commit dhcp
    /etc/init.d/dnsmasq restart
    echo "Applied: $(echo $DOMAINS | wc -w) domains blocked"
    ;;
  remove)
    for d in $DOMAINS; do uci -q del_list dhcp.@dnsmasq[0].address="/$d/" || true; done
    uci commit dhcp
    /etc/init.d/dnsmasq restart
    echo "Removed AI block list"
    ;;
  status)
    n=0
    for d in $DOMAINS; do
      uci -q get dhcp.@dnsmasq[0].address | tr ' ' '\n' | grep -qx "/$d/" && n=$((n+1))
    done
    echo "Blocked: $n of $(echo $DOMAINS | wc -w) domains"
    ;;
  *)
    echo "usage: $0 apply|remove|status" >&2
    exit 2
    ;;
esac
