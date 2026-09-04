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
#   /opt/senet/state              the listener's cursor, which no deployment touches
#
# The order of the three steps is the point, and each one depends on the one
# before it.
#
# The service goes first. The application reads its chain settings from
# `/api/config` at start, so an application that arrived first would meet a
# service that answers without them, and account creation would fail while the
# page still looked healthy.
#
# The listener goes second. It posts each redemption to the service, so the
# service has to answer before it starts.
#
# The application goes last. The merchant screen confirms from the feed that
# the listener fills, so an application that arrived first would show a screen
# with nothing behind it.
#
# Each swap renames a link, which the kernel does in one step, so no request
# ever sees half a release.
set -euo pipefail

SOURCE=${1:-$(pwd)}
TARGET=/opt/senet
UNIT=senet-api.service
LISTENER_UNIT=senet-listener.service
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

# The event listener keeps its cursor here. The directory sits beside `.env`
# rather than inside a release, because the release copy below runs with
# `--delete` and the prune at the end removes old releases outright. A cursor
# inside a release would not survive its own deployment.
mkdir -p "$TARGET/state"

# The listener needs somewhere to post. Without it the merchant screen confirms
# nothing, and a deployment that swapped anyway would serve an application whose
# central promise is quietly missing. That is worth refusing rather than
# reporting, so the check runs before anything moves.
if ! grep -q '^WEBHOOK_URL=.' "$TARGET/.env"; then
  echo "$TARGET/.env names no WEBHOOK_URL, so the listener has nowhere to post" >&2
  echo "the merchant screen confirms from that feed, so nothing is swapped" >&2
  echo "add: WEBHOOK_URL=http://127.0.0.1:8791/api/redemption" >&2
  exit 1
fi

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

# Publish the commit that this release carries. A content search cannot tell a
# release that lacks a change from a check that looks for the wrong string, and
# two people grepping for different things reach opposite answers. An origin
# that names its own commit settles that by answering rather than by inference.
COMMIT=$(sed -n 's/.*"commit": "\(.*\)".*/\1/p' "$RELEASE/deploy/release.json")
case "$COMMIT" in
  '$Format:'*)
    echo "the source is a checkout and not an export, so it names no commit" >&2
    echo "export it with: git archive --format=tar HEAD" >&2
    exit 1
    ;;
esac
cat > "$RELEASE/app/dist/release.json" <<JSON
{
  "commit": "$COMMIT",
  "release": "$STAMP",
  "publishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
echo "    release $STAMP carries commit $COMMIT"

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

# The listener sits between the two. It posts to the service, so the service has
# to answer first. The application reads the feed that the listener fills, so an
# application that arrived first would show a merchant screen with nothing
# behind it.
echo "==> the listener second"
install -m 0644 "$RELEASE/deploy/$LISTENER_UNIT" "/etc/systemd/system/$LISTENER_UNIT"
systemctl daemon-reload
systemctl enable "$LISTENER_UNIT" >/dev/null
# A listener held down by the aged-out status stays down until a person acts. A
# deployment is a person acting, so this clears that state and starts it again.
systemctl reset-failed "$LISTENER_UNIT" 2>/dev/null || true
systemctl restart "$LISTENER_UNIT"
sleep 2
if ! systemctl is-active --quiet "$LISTENER_UNIT"; then
  echo "the listener did not start, so the application stays on the older release" >&2
  echo "read: journalctl -u $LISTENER_UNIT -n 50" >&2
  exit 1
fi
echo "    the listener runs from $STAMP"

echo "==> the application third"
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
