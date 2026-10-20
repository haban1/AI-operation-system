FROM alpine:3.20

RUN apk add --no-cache iptables tcpdump

COPY entrypoint.sh /usr/local/bin/wechat-longlink-fix
RUN chmod +x /usr/local/bin/wechat-longlink-fix

ENTRYPOINT ["/usr/local/bin/wechat-longlink-fix"]
