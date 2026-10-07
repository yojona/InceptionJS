#!/usr/bin/env bash
# Runs a build command on a rented Hetzner Cloud server and brings the results
# back. The server is ALWAYS deleted when this script exits (it is billed until
# deleted), unless KEEP=1.
#
#   build/remote.sh [command...]        default command: build/all.sh
#
# Env:
#   TYPE       server type (cpx62)
#   LOC        location (fsn1)
#   IMAGE      image or snapshot id to start from (ubuntu-24.04)
#   SNAPSHOT=1 save a snapshot of the server disk (work dir + compiler cache)
#   FETCH      directory under the repo to copy back (.work/out)
#   BUILD_ENV  extra "NAME=value ..." passed to the command
#   KEEP=1     leave the server running
#   SSH_KEY    private key (~/.ssh/inceptionjs-build); its public half is registered
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TYPE="${TYPE:-cpx62}"
LOC="${LOC:-fsn1}"
IMAGE="${IMAGE:-ubuntu-24.04}"
FETCH="${FETCH:-.work/out}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/inceptionjs-build}"
KEY_NAME="inceptionjs-build"
NAME="inceptionjs-build-$(date +%Y%m%d-%H%M%S)"
COMMAND=("$@")
[ ${#COMMAND[@]} -gt 0 ] || COMMAND=(build/all.sh)

ssh_opts=(-i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ServerAliveInterval=30)
remote() { ssh "${ssh_opts[@]}" "root@$IP" "$@"; }

command -v hcloud >/dev/null || { echo "hcloud is required" >&2; exit 1; }
hcloud server-type describe "$TYPE" >/dev/null || { echo "hcloud not logged in, or no server type $TYPE" >&2; exit 1; }
hcloud ssh-key describe "$KEY_NAME" >/dev/null 2>&1 \
  || hcloud ssh-key create --name "$KEY_NAME" --public-key-from-file "$SSH_KEY.pub" >/dev/null

created=0
cleanup() {
  [ "$created" = 1 ] || return 0
  if [ "${KEEP:-0}" = 1 ]; then
    echo "KEEP=1: $NAME is still running and billing. Delete it with: hcloud server delete $NAME"
    return 0
  fi
  echo "deleting $NAME"
  hcloud server delete "$NAME" >/dev/null || echo "COULD NOT DELETE $NAME: run 'hcloud server delete $NAME'" >&2
}
trap cleanup EXIT INT TERM

echo "creating $NAME ($TYPE, $LOC, $IMAGE)"
hcloud server create --name "$NAME" --type "$TYPE" --location "$LOC" --image "$IMAGE" --ssh-key "$KEY_NAME" >/dev/null
created=1
IP="$(hcloud server ip "$NAME")"
for _ in $(seq 1 60); do remote -o ConnectTimeout=5 true 2>/dev/null && break; sleep 5; done

remote 'command -v docker >/dev/null || (apt-get update -qq && apt-get install -y -qq docker.io rsync >/dev/null)'
rsync -a --delete -e "ssh ${ssh_opts[*]}" \
  --exclude .work/ --exclude node_modules/ --exclude .git/ \
  "$ROOT/" "root@$IP:/srv/inceptionjs/"
remote 'cd /srv/inceptionjs && docker build -q -t inceptionjs-build build >/dev/null'

started=$(date +%s)
printf -v quoted '%q ' "${COMMAND[@]}"
status=0
remote "docker run --rm -v /srv/inceptionjs:/work/inceptionjs inceptionjs-build env ${BUILD_ENV:-} bash -c $(printf %q "$quoted")" || status=$?
echo "remote command took $(( $(date +%s) - started )) s (exit $status)"

# Logs come back even when the command failed; that is when they matter.
mkdir -p "$ROOT/.work/logs"
rsync -a -e "ssh ${ssh_opts[*]}" "root@$IP:/srv/inceptionjs/.work/logs/" "$ROOT/.work/logs/" || true
[ "$status" = 0 ] || exit "$status"

mkdir -p "$ROOT/$FETCH"
rsync -a -e "ssh ${ssh_opts[*]}" "root@$IP:/srv/inceptionjs/$FETCH/" "$ROOT/$FETCH/"
echo "fetched $FETCH"

if [ "${SNAPSHOT:-0}" = 1 ]; then
  echo "saving snapshot"
  hcloud server create-image "$NAME" --type snapshot --description "inceptionjs build $(date +%F)" >/dev/null
  hcloud image list --type snapshot -o noheader -o columns=id,description | grep inceptionjs | tail -1
fi
