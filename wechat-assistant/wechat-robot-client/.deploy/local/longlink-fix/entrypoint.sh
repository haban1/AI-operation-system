#!/bin/sh
set -eu

add_redirect() {
  ip="$1"
  if ! printf '%s\n' "$ip" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'; then
    return
  fi
  if iptables -t nat -C OUTPUT -p tcp -d "$ip" --dport 80 \
    -j DNAT --to-destination "$ip:8080" 2>/dev/null; then
    return
  fi
  iptables -t nat -A OUTPUT -p tcp -d "$ip" --dport 80 \
    -j DNAT --to-destination "$ip:8080"
  echo "Redirecting WeChat long link $ip:80 to $ip:8080"
}

echo "Watching for WeChat MMTLS long-link connections"
tcpdump -l -nn -s 80 -i eth0 \
  'tcp dst port 80 and tcp[((tcp[12] & 0xf0) >> 2)] = 0x16' 2>/dev/null |
while IFS= read -r line; do
  endpoint="$(printf '%s\n' "$line" | awk '{print $5}' | sed 's/:$//')"
  add_redirect "${endpoint%.80}"
done
