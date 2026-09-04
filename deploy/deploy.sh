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
# of an uncommitted tree would carry a file that nobody committed. A deployment
# would then serve code that no reader of the repository can see.
#
# The layout keeps every release in its own directory, and two links decide
# which one is live:
#
#   /opt/senet/releases/<stamp>   one build, complete and unserved
#   /opt/senet/service            the release that the service runs from
#   /opt/senet/live               the files that the web server serves
#   /opt/senet/.env               the keys, which no deployment replaces
#
# The order of the two swaps is the point. The service goes first and the
# application second. The application therefore never asks for a value that the
# service it talks to does not serve yet. The application reads its chain
# settings from `/api/config` at start. An application that arrives first
# therefore meets a service that answers without them, and account creation
# fails while the page still looks healthy.
#
# Each swap renames a link, which the kernel does in one step, so no request
# ever sees half a release.
set -euo pipefail

SOURCE=${1:-$(pwd)}
TARGET=/opt/senet
UNIT=senet-api.service
KEEP=3

if [ ! -f "$SOURCE/package.json" ]; then
  echo "$SOURCE holds no package.json, so it is not a checkout" >&2
  exit 1
fi
if [ ! -f "$TARGET/.env" ]; then
  echo "$TARGET/.env is missing, and the service cannot start without it" >&2
  exit 1
fi
chmod 600 "$TARGET/.env"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RELEASE="$TARGET/releases/$STAMP"

echo "==> building release $STAMP"
mkdir -p "$RELEASE"
# Each pattern that names one directory carries a leading slash, which anchors
# it to the root of the transfer. Without that anchor rsync matches the name at
# any depth, so `target/` would also drop a directory of that name inside a
# package. `node_modules` and `.git` stay unanchored on purpose, because they
# appear at every depth.
rsync -a --delete \
  --exclude '.git/' --exclude 'node_modules/' --exclude '/target/' \
  --exclude '/.env' --exclude '/scripts/out/' \
  "$SOURCE"/ "$RELEASE"/
cd "$RELEASE"
npm install --no-audit --no-fund
npm run build
if [ ! -f "$RELEASE/app/dist/index.html" ]; then
  echo "the build produced no application, so nothing is swapped" >&2
  exit 1
fi

echo "==> installing the web server configuration"
mkdir -p /etc/nginx/snippets
install -m 0644 "$RELEASE/deploy/nginx-senet-common-headers.conf" \
  /etc/nginx/snippets/senet-common-headers.conf
install -m 0644 "$RELEASE/deploy/nginx-senet.conf" /etc/nginx/sites-available/senet
ln -sfn /etc/nginx/sites-available/senet /etc/nginx/sites-enabled/senet
nginx -t

# Swap one link in a single step, so no request sees a directory that sits
# halfway between two releases.
swap() {
  ln -sfn "$1" "$2.swapping"
  mv -T "$2.swapping" "$2"
}

echo "==> the service first"
install -m 0644 "$RELEASE/deploy/$UNIT" "/etc/systemd/system/$UNIT"
swap "$RELEASE" "$TARGET/service"
systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null
systemctl restart "$UNIT"

for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 5 http://127.0.0.1:8791/api/config > /dev/null; then
    echo "    the service answers from $STAMP"
    break
  fi
  if [ "$attempt" = 30 ]; then
    echo "the service did not answer, so the application stays on the older release" >&2
    echo "read: journalctl -u $UNIT -n 50" >&2
    exit 1
  fi
  sleep 1
done

echo "==> the application second"
swap "$RELEASE/app/dist" "$TARGET/live"
systemctl reload nginx
echo "    the web server serves $STAMP"

echo "==> removing every release except the newest $KEEP"
cd "$TARGET/releases"
running=$(readlink -f "$TARGET/service")
ls -1 | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
  if [ "$TARGET/releases/$old" != "$running" ]; then
    rm -rf "${TARGET:?}/releases/${old:?}"
    echo "    removed $old"
  fi
done

echo "==> done. Check it from outside the host:"
echo "    CHROME_PATH=/path/to/chrome node $RELEASE/deploy/verify.mjs"
