#!/usr/bin/env bash
#
# Deploy Senet to the host that serves senet.hoodrun.io.
#
# Export the committed tree to the host, then run this script there:
#
#   git archive --format=tar HEAD | ssh root@HOST \
#     'rm -rf /opt/senet-src && mkdir -p /opt/senet-src && tar -x -C /opt/senet-src'
#   ssh root@HOST 'bash /opt/senet-src/deploy/deploy.sh /opt/senet-src'
#
# `git archive HEAD` carries what the repository holds and nothing else. A copy
# of a working directory would carry a file that nobody committed, and a
# deployment would then serve code that no reader of the repository can see.
#
# The script copies the source to /opt/senet, builds it there, and restarts the
# service. It never writes /opt/senet/.env, so a deployment cannot lose the
# channel keys. Write that file once, with the account tool that the README
# names.
set -euo pipefail

SOURCE=${1:-$(pwd)}
TARGET=/opt/senet
UNIT=senet-api.service

if [ ! -f "$SOURCE/package.json" ]; then
  echo "$SOURCE holds no package.json, so it is not a checkout" >&2
  exit 1
fi

echo "==> copying $SOURCE to $TARGET"
mkdir -p "$TARGET"
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'target/' \
  --exclude '.env' \
  --exclude 'scripts/out/' \
  "$SOURCE"/ "$TARGET"/

if [ ! -f "$TARGET/.env" ]; then
  echo "$TARGET/.env is missing, and the service cannot start without it" >&2
  exit 1
fi
chmod 600 "$TARGET/.env"

echo "==> building"
cd "$TARGET"
npm install --no-audit --no-fund
npm run build

echo "==> installing the web server configuration"
mkdir -p /etc/nginx/snippets
install -m 0644 "$TARGET/deploy/nginx-senet-common-headers.conf" \
  /etc/nginx/snippets/senet-common-headers.conf
install -m 0644 "$TARGET/deploy/nginx-senet.conf" /etc/nginx/sites-available/senet
ln -sfn /etc/nginx/sites-available/senet /etc/nginx/sites-enabled/senet
nginx -t
systemctl reload nginx

echo "==> installing the service"
install -m 0644 "$TARGET/deploy/$UNIT" "/etc/systemd/system/$UNIT"
systemctl daemon-reload
systemctl enable "$UNIT"
systemctl restart "$UNIT"

echo "==> waiting for the service"
for attempt in $(seq 1 20); do
  if curl --fail --silent --max-time 5 http://127.0.0.1:8791/api/config > /dev/null; then
    echo "the service answers on 127.0.0.1:8791"
    break
  fi
  if [ "$attempt" = 20 ]; then
    echo "the service did not answer. Read: journalctl -u $UNIT -n 50" >&2
    exit 1
  fi
  sleep 1
done

echo "==> done. Verify from outside the host:"
echo "    curl -sI https://senet.hoodrun.io/"
echo "    curl -s  https://senet.hoodrun.io/api/config"
echo "    curl -sI https://senet.hoodrun.io/.well-known/stellar.toml"
