#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:?APP_DIR is required}"
BASE_DIR="${BASE_DIR:-/mnt/www/customer-service}"
APP_NAME="${APP_NAME:-enterprise-faq-customer-service}"
IMAGE_NAME="${IMAGE_NAME:-enterprise-faq-customer-service:latest}"
HOST_PORT="${HOST_PORT:-88}"
DATA_DIR="$BASE_DIR/data"
SECRET_FILE="$BASE_DIR/secret_key"
ENV_FILE="$BASE_DIR/.env"
PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-ai-architect-assessment.s187.intellidriven.cn}"

print_access_url() {
  local public_ip=""
  local metadata_path

  if command -v curl >/dev/null 2>&1; then
    for metadata_path in eipv4 public-ipv4; do
      public_ip="$(curl -fsS --max-time 2 \
        "http://100.100.100.200/latest/meta-data/$metadata_path" 2>/dev/null || true)"
      if [[ "$public_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        break
      fi
      public_ip=""
    done

    if [ -z "$public_ip" ]; then
      public_ip="$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
    fi
  fi

  if [[ "$public_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "[INFO] Public access URL: http://$public_ip:$HOST_PORT"
  else
    echo "[WARN] Public IP was not detected; verify port $HOST_PORT with the server's public address."
  fi
}

set_env_value() {
  local key="$1"
  local value="$2"
  local temp_file

  temp_file="$(mktemp "$ENV_FILE.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { updated = 0 }
    $0 ~ ("^" key "=") {
      if (!updated) {
        print key "=" value
        updated = 1
      }
      next
    }
    { print }
    END {
      if (!updated) {
        print key "=" value
      }
    }
  ' "$ENV_FILE" >"$temp_file"
  chmod --reference="$ENV_FILE" "$temp_file" 2>/dev/null || chmod 600 "$temp_file"
  mv "$temp_file" "$ENV_FILE"
}

resolve_wecom_kf_open_kfid() {
  local resolved_kfid=""
  local resolver_error=""
  local error_file

  if [ ! -f "$ENV_FILE" ]; then
    return
  fi

  error_file="$(mktemp)"
  if resolved_kfid="$(docker run --rm \
    --env-file "$ENV_FILE" \
    "$IMAGE_NAME" \
    python -m app.wecom.account_resolver 2>"$error_file")"; then
    if [[ "$resolved_kfid" =~ ^[A-Za-z0-9_-]+$ ]]; then
      set_env_value "WECOM_KF_OPEN_KFID" "$resolved_kfid"
      echo "[INFO] Updated WECOM_KF_OPEN_KFID from the authorized WeCom customer service account."
    else
      echo "[WARN] Ignoring an invalid WECOM_KF_OPEN_KFID returned by the resolver." >&2
    fi
  else
    resolver_error="$(tail -n 1 "$error_file" 2>/dev/null || true)"
    echo "[WARN] Could not resolve WECOM_KF_OPEN_KFID automatically: $resolver_error" >&2
  fi
  rm -f "$error_file"
}

ensure_wecom_kf_handoff_servicer() {
  local servicer_userid=""
  local manager_error=""
  local error_file

  if [ ! -f "$ENV_FILE" ] \
    || ! grep -qE '^WECOM_KF_HANDOFF_SERVICER_USERID=.+$' "$ENV_FILE"; then
    echo "[INFO] WeCom handoff will use the shared waiting pool."
    return
  fi

  error_file="$(mktemp)"
  if servicer_userid="$(docker run --rm \
    --env-file "$ENV_FILE" \
    "$IMAGE_NAME" \
    python -m app.wecom.servicer_manager 2>"$error_file")"; then
    echo "[INFO] WeCom direct handoff servicer is ready: $servicer_userid"
  else
    manager_error="$(tail -n 1 "$error_file" 2>/dev/null || true)"
    echo "[ERROR] Could not configure the WeCom handoff servicer: $manager_error" >&2
    rm -f "$error_file"
    return 1
  fi
  rm -f "$error_file"
}

ensure_host_port_access() {
  if command -v firewall-cmd >/dev/null 2>&1 \
    && systemctl is-active --quiet firewalld; then
    firewall-cmd --permanent --add-port="$HOST_PORT/tcp"
    firewall-cmd --reload
    echo "[INFO] Opened $HOST_PORT/tcp in firewalld."
    return
  fi

  if command -v ufw >/dev/null 2>&1 \
    && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow "$HOST_PORT/tcp"
    echo "[INFO] Opened $HOST_PORT/tcp in ufw."
    return
  fi

  echo "[INFO] No active host firewall detected; ensure the cloud security group allows $HOST_PORT/tcp."
}

configure_nginx_proxy() {
  local nginx_dir="/www/server/panel/vhost/nginx"
  local config_path="$nginx_dir/$PUBLIC_DOMAIN.conf"
  local backup_path="$config_path.customer-service-backup"
  local certificate_dir="/www/server/panel/vhost/cert/$PUBLIC_DOMAIN"
  local document_root="/www/wwwroot/$PUBLIC_DOMAIN"

  if ! command -v nginx >/dev/null 2>&1; then
    echo "[ERROR] Nginx is not installed on the deployment host." >&2
    return 1
  fi

  if [ ! -s "$certificate_dir/fullchain.pem" ] \
    || [ ! -s "$certificate_dir/privkey.pem" ]; then
    echo "[ERROR] TLS certificate files for $PUBLIC_DOMAIN were not found." >&2
    return 1
  fi

  if [ -f "$config_path" ] && [ ! -f "$backup_path" ]; then
    cp -a "$config_path" "$backup_path"
  fi

  mkdir -p "$nginx_dir" "$document_root/.well-known/acme-challenge"
  cat >"$config_path" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $PUBLIC_DOMAIN;

    location ^~ /.well-known/acme-challenge/ {
        root $document_root;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $PUBLIC_DOMAIN;

    ssl_certificate $certificate_dir/fullchain.pem;
    ssl_certificate_key $certificate_dir/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    client_max_body_size 20m;
    add_header Strict-Transport-Security "max-age=31536000" always;

    location / {
        proxy_pass http://127.0.0.1:$HOST_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
EOF

  if ! nginx -t; then
    echo "[ERROR] Nginx validation failed; restoring the previous configuration." >&2
    if [ -f "$backup_path" ]; then
      cp -a "$backup_path" "$config_path"
      nginx -t
    fi
    return 1
  fi

  nginx -s reload
  curl -fsS --max-time 10 \
    --resolve "$PUBLIC_DOMAIN:443:127.0.0.1" \
    "https://$PUBLIC_DOMAIN/health" >/dev/null
  echo "[INFO] HTTPS access URL: https://$PUBLIC_DOMAIN"
}

mkdir -p "$DATA_DIR"

if [ ! -s "$SECRET_FILE" ]; then
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
fi

SECRET_KEY="$(cat "$SECRET_FILE")"
ENV_ARGS=()
if [ -f "$ENV_FILE" ]; then
  ENV_ARGS=(--env-file "$ENV_FILE")
fi

docker build -t "$IMAGE_NAME" "$APP_DIR"
resolve_wecom_kf_open_kfid
ensure_wecom_kf_handoff_servicer

ensure_host_port_access
docker rm -f "$APP_NAME" medical-communication-rag paper-translation 2>/dev/null || true
docker run -d \
  --name "$APP_NAME" \
  --restart unless-stopped \
  -p "$HOST_PORT:8000" \
  -v "$DATA_DIR:/app/data" \
  "${ENV_ARGS[@]}" \
  -e "DATABASE_URL=sqlite:////app/data/agent.db" \
  -e "SECRET_KEY=$SECRET_KEY" \
  -e "FAQ_TAXONOMY_VERSION=faq-taxonomy-v3" \
  "$IMAGE_NAME"

for attempt in $(seq 1 30); do
  if docker exec "$APP_NAME" python -c \
    "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).read()"; then
    echo "[INFO] Deployment is healthy on port $HOST_PORT."
    configure_nginx_proxy
    print_access_url
    exit 0
  fi
  sleep 2
done

docker logs --tail 100 "$APP_NAME" >&2
echo "[ERROR] Health check failed." >&2
exit 1
