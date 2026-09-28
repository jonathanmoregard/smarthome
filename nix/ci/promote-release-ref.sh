#!/usr/bin/env bash
set -euo pipefail

die() {
  echo "promote-release-ref: $*" >&2
  exit 2
}

[[ "$#" -eq 2 ]] || die 'usage: promote-release-ref.sh <ref-name> <candidate>'

ref_name="$1"
candidate="$2"

case "$ref_name" in
  release/app | release/home-server) ;;
  *) die "unsupported release ref: $ref_name" ;;
esac

[[ -n "${GITHUB_SHA:-}" ]] || die 'GITHUB_SHA is required'
[[ "$candidate" == "$GITHUB_SHA" ]] || die 'candidate must equal GITHUB_SHA'
[[ "$candidate" =~ ^[0-9a-fA-F]{40}$ ]] || die 'candidate must be a full commit SHA'
[[ "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die 'GITHUB_REPOSITORY must be owner/repository'

read_ref_endpoint="repos/$GITHUB_REPOSITORY/git/ref/heads/$ref_name"
update_ref_endpoint="repos/$GITHUB_REPOSITORY/git/refs/heads/$ref_name"
refs_endpoint="repos/$GITHUB_REPOSITORY/git/refs"

read_current() {
  gh api --method GET "$read_ref_endpoint" --jq '.object.sha'
}

compare_candidate() {
  local current="$1"
  gh api --method GET "repos/$GITHUB_REPOSITORY/compare/$current...$candidate" --jq '.status'
}

current=
if ! current="$(read_current 2>/dev/null)"; then
  if gh api \
    --method POST \
    "$refs_endpoint" \
    -f "ref=refs/heads/$ref_name" \
    -f "sha=$candidate" \
    --silent; then
    exit 0
  fi

  # A concurrent promotion may have created the ref after our initial read.
  current="$(read_current)" || die 'release ref could not be read after create failed'
fi

[[ "$current" =~ ^[0-9a-fA-F]{40}$ ]] || die 'release ref did not resolve to a full commit SHA'
[[ "$current" == "$candidate" ]] && exit 0

status="$(compare_candidate "$current")" || die 'failed to compare release ref with candidate'
case "$status" in
  ahead)
    if gh api \
      --method PATCH \
      "$update_ref_endpoint" \
      -f "sha=$candidate" \
      -F 'force=false' \
      --silent; then
      exit 0
    fi

    # A non-forced update can lose a race to a newer successful promotion.
    refreshed="$(read_current)" || die 'release ref update failed and the ref could not be refreshed'
    [[ "$refreshed" == "$candidate" ]] && exit 0
    refreshed_status="$(compare_candidate "$refreshed")" || die 'release ref update failed and ancestry could not be refreshed'
    case "$refreshed_status" in
      behind | identical) exit 0 ;;
      *) die 'release ref changed concurrently and cannot be fast-forwarded safely' ;;
    esac
    ;;
  behind | identical)
    # This workflow finished after a newer promotion; never rewind the ref.
    exit 0
    ;;
  diverged)
    die 'candidate diverges from the promoted release ref'
    ;;
  *)
    die "unexpected GitHub comparison status: $status"
    ;;
esac
